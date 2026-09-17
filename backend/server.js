const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const client = new MongoClient(process.env.MONGODB_URI);
let db;

app.use(cors());
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "..")));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "khetse123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "KHETSE_ADMIN_2026";

function oid(id){ try{return new ObjectId(id)}catch{return null} }

function sellerToken(){ return crypto.randomBytes(32).toString("hex"); }
function hashToken(token){ return crypto.createHash("sha256").update(String(token)).digest("hex"); }
function payoutKey(){ return crypto.createHash("sha256").update(String(process.env.PAYOUT_ENCRYPTION_KEY || ADMIN_TOKEN)).digest(); }
function encryptSecret(value){
  const text=String(value||""); if(!text) return "";
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv("aes-256-gcm",payoutKey(),iv);
  const encrypted=Buffer.concat([cipher.update(text,"utf8"),cipher.final()]);
  const tag=cipher.getAuthTag();
  return [iv.toString("base64"),tag.toString("base64"),encrypted.toString("base64")].join(".");
}
function decryptSecret(value){
  try{ if(!value) return ""; const [ivB,tagB,dataB]=String(value).split(".");
    const decipher=crypto.createDecipheriv("aes-256-gcm",payoutKey(),Buffer.from(ivB,"base64"));
    decipher.setAuthTag(Buffer.from(tagB,"base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB,"base64")),decipher.final()]).toString("utf8");
  }catch{return "";}
}
function maskSecret(value,visible=4){ const s=String(value||""); if(!s)return ""; if(s.length<=visible)return "*".repeat(s.length); return "*".repeat(Math.max(4,s.length-visible))+s.slice(-visible); }
function cleanPayoutDetails(s){
  const p=s?.payoutDetails||{};
  return {method:p.method||"",upiId:p.upiId||"",accountHolderName:p.accountHolderName||"",bankName:p.bankName||"",accountNumber:p.accountNumber?maskSecret(decryptSecret(p.accountNumber),4):"",ifsc:p.ifsc||"",configured:!!p.method};
}
function payoutDetailsForStorage(input){
  const p=input||{}, method=String(p.method||"").trim().toLowerCase();
  if(!["upi","bank"].includes(method)) throw new Error("Payout method UPI ya Bank Account hona chahiye");
  if(method==="upi") {
    const upi=String(p.upiId||"").trim();
    if(!/^[^\s@]+@[^\s@]+$/.test(upi)) throw new Error("Valid UPI ID required");
    return {method:"upi",upiId:upi,accountHolderName:"",bankName:"",accountNumber:"",ifsc:"",updatedAt:new Date()};
  }
  const holder=String(p.accountHolderName||"").trim(), bank=String(p.bankName||"").trim(), account=String(p.accountNumber||"").replace(/\s+/g,""), ifsc=String(p.ifsc||"").trim().toUpperCase();
  if(!holder||!bank||!/^\d{8,20}$/.test(account)||!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error("Valid bank account holder, bank, account number aur IFSC required");
  return {method:"bank",upiId:"",accountHolderName:holder,bankName:bank,accountNumber:encryptSecret(account),ifsc,updatedAt:new Date()};
}
function cleanSeller(s){
  return {id:s._id?.toString?.()||s._id,name:s.name||"",shopName:s.shopName||"",mobile:s.mobile||"",city:s.city||"",address:s.address||"",pincode:s.pincode||"",description:s.description||"",houseShopNo:s.houseShopNo||"",streetRoad:s.streetRoad||"",locality:s.locality||"",landmark:s.landmark||"",district:s.district||s.city||"",state:s.state||"Uttar Pradesh",createdAt:s.createdAt,status:s.status||"active",payoutDetails:cleanPayoutDetails(s)};
}

const DEFAULT_COMMISSION_RATE=10;
async function getCommissionRate(){
  try{
    const setting=await db.collection("settings").findOne({_id:"commission"});
    const rate=Number(setting?.rate);
    return Number.isFinite(rate)&&rate>=0&&rate<=100?rate:DEFAULT_COMMISSION_RATE;
  }catch{return DEFAULT_COMMISSION_RATE;}
}
function commissionFor(amount,rate){
  const base=Math.max(0,Number(amount)||0);
  const r=Math.max(0,Math.min(100,Number(rate)||0));
  const commission=Math.round(base*r)/100;
  return {commission:Math.round(commission*100)/100,net:Math.round((base-commission)*100)/100};
}

async function requireSeller(req,res,next){
  try{
    const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if(!token)return res.status(401).json({success:false,message:"Seller login required"});
    const session=await db.collection("sellerSessions").findOne({tokenHash:hashToken(token),expiresAt:{$gt:new Date()}});
    if(!session)return res.status(401).json({success:false,message:"Seller session expired. Please login again."});
    const seller=await db.collection("sellers").findOne({_id:session.sellerId});
    if(!seller)return res.status(401).json({success:false,message:"Seller account nahi mila"});
    req.seller=seller;
    req.sellerSession=session;
    next();
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller authentication failed"});}
}

app.post("/api/sellers/signup",async(req,res)=>{
  try{
    const {name,shopName,mobile,password,city,address,pincode,description,houseShopNo,streetRoad,locality,landmark,district,state}=req.body||{};
    if(!name||!shopName||!mobile||!password||!city||!address||!pincode)return res.status(400).json({success:false,message:"Sabhi required details bharo"});
    if(!/^\d{10}$/.test(String(mobile)))return res.status(400).json({success:false,message:"Valid 10 digit mobile number required"});
    if(String(password).length<6)return res.status(400).json({success:false,message:"Password at least 6 characters ka hona chahiye"});
    if(!/^\d{6}$/.test(String(pincode)))return res.status(400).json({success:false,message:"Valid 6 digit pincode required"});
    const existing=await db.collection("sellers").findOne({mobile:String(mobile)});
    if(existing)return res.status(400).json({success:false,message:"Ye mobile number seller account mein already registered hai"});
    const hash=await bcrypt.hash(String(password),10);
    const seller={name:String(name).trim(),shopName:String(shopName).trim(),mobile:String(mobile),password:hash,city:String(city).trim(),
      address:String(address||"").trim(),pincode:String(pincode),description:String(description||"").trim(),
      houseShopNo:String(houseShopNo||"").trim(),streetRoad:String(streetRoad||"").trim(),locality:String(locality||"").trim(),
      landmark:String(landmark||"").trim(),district:String(district||city).trim(),state:String(state||"Uttar Pradesh").trim(),
      status:"active",createdAt:new Date(),updatedAt:new Date()};
    const r=await db.collection("sellers").insertOne(seller);
    res.status(201).json({success:true,message:"Seller account successfully created",sellerId:r.insertedId});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller signup failed"});}
});

app.post("/api/sellers/login",async(req,res)=>{
  try{
    const {mobile,password}=req.body||{};
    const seller=await db.collection("sellers").findOne({mobile:String(mobile||"")});
    if(!seller)return res.status(401).json({success:false,message:"Seller mobile number registered nahi hai"});
    if(seller.status!=="active")return res.status(403).json({success:false,message:"Seller account inactive hai. Admin se contact karein."});
    const valid=await bcrypt.compare(String(password||""),String(seller.password||""));
    if(!valid)return res.status(401).json({success:false,message:"Password galat hai"});
    const token=sellerToken();
    await db.collection("sellerSessions").insertOne({sellerId:seller._id,tokenHash:hashToken(token),createdAt:new Date(),expiresAt:new Date(Date.now()+30*24*60*60*1000)});
    res.json({success:true,message:"Seller login successful",token,seller:cleanSeller(seller)});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller login failed"});}
});

app.get("/api/sellers/me",requireSeller,async(req,res)=>res.json({success:true,seller:cleanSeller(req.seller)}));

app.put("/api/sellers/profile",requireSeller,async(req,res)=>{
  try{
    const {name,shopName,city,address,pincode,description,houseShopNo,streetRoad,locality,landmark,district,state}=req.body||{};
    if(!name||!shopName||!city||!address||!/^(\d{6})$/.test(String(pincode)))return res.status(400).json({success:false,message:"Name, shop name, city, address aur valid pincode required"});
    const update={name:String(name).trim(),shopName:String(shopName).trim(),city:String(city).trim(),address:String(address).trim(),pincode:String(pincode),
      description:String(description||"").trim(),houseShopNo:String(houseShopNo||"").trim(),streetRoad:String(streetRoad||"").trim(),
      locality:String(locality||"").trim(),landmark:String(landmark||"").trim(),district:String(district||city).trim(),
      state:String(state||"Uttar Pradesh").trim(),updatedAt:new Date()};
    await db.collection("sellers").updateOne({_id:req.seller._id},{$set:update});
    const seller=await db.collection("sellers").findOne({_id:req.seller._id});
    res.json({success:true,message:"Seller profile updated successfully",seller:cleanSeller(seller)});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller profile update failed"});}
});

app.get("/api/sellers/payout-details",requireSeller,async(req,res)=>{
  try{ res.json({success:true,payoutDetails:cleanPayoutDetails(req.seller)}); }
  catch(e){res.status(500).json({success:false,message:"Payout details load failed"});}
});

app.put("/api/sellers/payout-details",requireSeller,async(req,res)=>{
  try{
    const payoutDetails=payoutDetailsForStorage(req.body||{});
    await db.collection("sellers").updateOne({_id:req.seller._id},{$set:{payoutDetails,updatedAt:new Date()}});
    const seller=await db.collection("sellers").findOne({_id:req.seller._id});
    res.json({success:true,message:"Payout details saved successfully",payoutDetails:cleanPayoutDetails(seller),seller:cleanSeller(seller)});
  }catch(e){res.status(400).json({success:false,message:e.message||"Payout details save failed"});}
});

app.post("/api/sellers/logout",requireSeller,async(req,res)=>{
  try{await db.collection("sellerSessions").deleteOne({_id:req.sellerSession._id});res.json({success:true,message:"Seller logout successful"});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Seller logout failed"});}
});

// Seller product management: every seller can only manage their own products.
app.get("/api/sellers/products",requireSeller,async(req,res)=>{
  try{
    const products=await db.collection("products").find({sellerId:req.seller._id}).sort({createdAt:-1,_id:-1}).toArray();
    res.json({success:true,products:products.map(cleanProduct)});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller products fetch failed"});}
});

app.post("/api/sellers/products",requireSeller,async(req,res)=>{
  try{
    const {name,price,stock,category,description,image,badge}=req.body||{};
    if(!String(name||"").trim()||!Number.isFinite(Number(price))||Number(price)<0||!Number.isInteger(Number(stock))||Number(stock)<0)
      return res.status(400).json({success:false,message:"Name, valid price aur valid stock required"});
    const product={
      name:String(name).trim(),price:Number(price),stock:Number(stock),category:String(category||"other").trim(),
      description:String(description||"").trim(),image:String(image||"").trim(),badge:String(badge||"").trim(),
      sellerId:req.seller._id,sellerName:req.seller.name,sellerShopName:req.seller.shopName,sellerCity:req.seller.city,
      createdAt:new Date(),updatedAt:new Date()
    };
    const r=await db.collection("products").insertOne(product);
    res.status(201).json({success:true,message:"Product successfully listed",productId:r.insertedId,product:cleanProduct({...product,_id:r.insertedId})});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller product add failed"});}
});

app.patch("/api/sellers/products/:id",requireSeller,async(req,res)=>{
  try{
    const id=oid(req.params.id);
    const {name,price,stock,category,description,image,badge}=req.body||{};
    if(!id)return res.status(400).json({success:false,message:"Invalid product id"});
    if(!String(name||"").trim()||!Number.isFinite(Number(price))||Number(price)<0||!Number.isInteger(Number(stock))||Number(stock)<0)
      return res.status(400).json({success:false,message:"Valid product details required"});
    const update={name:String(name).trim(),price:Number(price),stock:Number(stock),category:String(category||"other").trim(),description:String(description||"").trim(),image:String(image||"").trim(),badge:String(badge||"").trim(),sellerName:req.seller.name,sellerShopName:req.seller.shopName,sellerCity:req.seller.city,updatedAt:new Date()};
    const r=await db.collection("products").updateOne({_id:id,sellerId:req.seller._id},{$set:update});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Aapka product nahi mila"});
    const product=await db.collection("products").findOne({_id:id});
    res.json({success:true,message:"Product updated successfully",product:cleanProduct(product)});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller product update failed"});}
});

app.patch("/api/sellers/products/:id/stock",requireSeller,async(req,res)=>{
  try{
    const id=oid(req.params.id),stock=Number(req.body.stock);
    if(!id||!Number.isInteger(stock)||stock<0)return res.status(400).json({success:false,message:"Valid stock quantity bhejo"});
    const r=await db.collection("products").updateOne({_id:id,sellerId:req.seller._id},{$set:{stock,updatedAt:new Date()}});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Aapka product nahi mila"});
    res.json({success:true,message:"Stock updated successfully"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller stock update failed"});}
});

app.delete("/api/sellers/products/:id",requireSeller,async(req,res)=>{
  try{
    const id=oid(req.params.id);if(!id)return res.status(400).json({success:false,message:"Invalid product id"});
    const r=await db.collection("products").deleteOne({_id:id,sellerId:req.seller._id});
    if(!r.deletedCount)return res.status(404).json({success:false,message:"Aapka product nahi mila"});
    res.json({success:true,message:"Product deleted successfully"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller product delete failed"});}
});

function cleanProduct(p){
  return {...p, _id:p._id?.toString?.()||p._id, price:Number(p.price||0), stock:Number(p.stock||0)};
}

app.get("/api/health",(req,res)=>res.json({success:true,message:"KhetSe API running"}));

app.post("/api/admin/login",(req,res)=>{
  const {username,password}=req.body||{};
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD) return res.json({success:true,token:ADMIN_TOKEN});
  return res.status(401).json({success:false,message:"Invalid username or password"});
});

function requireAdmin(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(token!==ADMIN_TOKEN)return res.status(401).json({success:false,message:"Admin login required"});
  next();
}

// Commission settings
app.get("/api/admin/commission",requireAdmin,async(req,res)=>{
  try{const rate=await getCommissionRate();res.json({success:true,rate});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Commission setting load failed"});}
});

app.patch("/api/admin/commission",requireAdmin,async(req,res)=>{
  try{
    const rate=Number(req.body?.rate);
    if(!Number.isFinite(rate)||rate<0||rate>100)return res.status(400).json({success:false,message:"Commission 0 se 100 ke beech hona chahiye"});
    await db.collection("settings").updateOne({_id:"commission"},{$set:{rate,updatedAt:new Date()}},{upsert:true});
    res.json({success:true,message:"Commission rate updated successfully",rate});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Commission setting update failed"});}
});

// Admin seller management
app.get("/api/admin/sellers",requireAdmin,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const filter=q?{$or:[
      {name:{$regex:q,$options:"i"}},{shopName:{$regex:q,$options:"i"}},{mobile:{$regex:q,$options:"i"}},
      {city:{$regex:q,$options:"i"}},{district:{$regex:q,$options:"i"}},{pincode:{$regex:q,$options:"i"}}
    ]}:{};
    const sellers=await db.collection("sellers").find(filter).project({password:0}).sort({createdAt:-1,_id:-1}).toArray();
    const ids=sellers.map(s=>s._id);
    const [products,orders]=await Promise.all([
      ids.length?db.collection("products").find({sellerId:{$in:ids}}).project({name:1,price:1,stock:1,sellerId:1}).toArray():[],
      ids.length?db.collection("orders").find({"items.sellerId":{$in:ids.map(String)}}).project({items:1,total:1,status:1,createdAt:1,orderNumber:1}).toArray():[]
    ]);
    const result=sellers.map(s=>{
      const sid=String(s._id);
      const ps=products.filter(p=>String(p.sellerId||"")===sid);
      const os=orders.filter(o=>(o.items||[]).some(i=>String(i.sellerId||"")===sid));
      let sellerSales=0,sellerCommission=0;
      for(const o of os){const f=o.sellerFinancials?.[sid];if(f){sellerSales+=Number(f.subtotal||0);sellerCommission+=Number(f.commission||0);}}
      return {...cleanSeller(s),productCount:ps.length,orderCount:os.length,
        activeProducts:ps.filter(p=>Number(p.stock)>0).length,sellerSales,sellerCommission};
    });
    res.json({success:true,sellers:result});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller list fetch failed"});}
});

app.patch("/api/admin/sellers/:id/status",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id),status=String(req.body?.status||"");
    if(!id||!["active","inactive"].includes(status))return res.status(400).json({success:false,message:"Invalid seller status"});
    const r=await db.collection("sellers").updateOne({_id:id},{$set:{status,updatedAt:new Date()}});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Seller nahi mila"});
    if(status==="inactive")await db.collection("sellerSessions").deleteMany({sellerId:id});
    res.json({success:true,message:`Seller ${status==="active"?"activated":"deactivated"} successfully`});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller status update failed"});}
});

app.get("/api/admin/sellers/:id",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id);if(!id)return res.status(400).json({success:false,message:"Invalid seller id"});
    const seller=await db.collection("sellers").findOne({_id:id},{projection:{password:0}});
    if(!seller)return res.status(404).json({success:false,message:"Seller nahi mila"});
    const products=await db.collection("products").find({sellerId:id}).sort({createdAt:-1}).toArray();
    const orders=await db.collection("orders").find({"items.sellerId":id.toString()}).sort({createdAt:-1}).toArray();
    res.json({success:true,seller:cleanSeller(seller),products:products.map(cleanProduct),orders});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller details fetch failed"});}
});

app.get("/api/products",async(req,res)=>{
  try{
    const products=await db.collection("products").find({}).sort({createdAt:-1,_id:-1}).toArray();
    const sellerIds=[...new Set(products.filter(p=>p.sellerId).map(p=>String(p.sellerId)))].map(oid).filter(Boolean);
    const sellers=sellerIds.length?await db.collection("sellers").find({_id:{$in:sellerIds}}).project({name:1,shopName:1,city:1,status:1}).toArray():[];
    const sellerMap=new Map(sellers.map(s=>[String(s._id),s]));
    const enriched=products.map(p=>{
      const seller=p.sellerId?sellerMap.get(String(p.sellerId)):null;
      return cleanProduct({...p, sellerId:p.sellerId?.toString?.()||p.sellerId||"", sellerName:seller?.name||p.sellerName||"", sellerShopName:seller?.shopName||p.sellerShopName||"", sellerCity:seller?.city||p.sellerCity||"", sellerStatus:seller?.status||""});
    });
    res.json({success:true,products:enriched});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Products fetch failed"});}
});

app.post("/api/products",requireAdmin,async(req,res)=>{
  try{
    const {name,price,stock,category,description,image,badge}=req.body||{};
    if(!name||Number(price)<0||Number(stock)<0)return res.status(400).json({success:false,message:"Name, valid price and stock required"});
    const product={name:String(name).trim(),price:Number(price),stock:Number(stock),category:category||"other",description:description||"",image:image||"",badge:badge||"",createdAt:new Date(),updatedAt:new Date()};
    const r=await db.collection("products").insertOne(product);
    res.status(201).json({success:true,productId:r.insertedId});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Product add failed"});}
});

app.patch("/api/products/:id",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id);if(!id)return res.status(400).json({success:false,message:"Invalid product id"});
    const update={name:String(req.body.name||"").trim(),price:Number(req.body.price),stock:Number(req.body.stock),category:req.body.category||"other",description:req.body.description||"",image:req.body.image||"",badge:req.body.badge||"",updatedAt:new Date()};
    if(!update.name||update.price<0||update.stock<0)return res.status(400).json({success:false,message:"Valid product details required"});
    const r=await db.collection("products").updateOne({_id:id},{$set:update});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Product nahi mila"});
    res.json({success:true,message:"Product updated successfully"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Product update failed"});}
});

app.patch("/api/products/:id/stock",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id),stock=Number(req.body.stock);
    if(!id||!Number.isInteger(stock)||stock<0)return res.status(400).json({success:false,message:"Valid stock quantity bhejo"});
    const r=await db.collection("products").updateOne({_id:id},{$set:{stock,updatedAt:new Date()}});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Product nahi mila"});
    res.json({success:true,message:"Stock updated"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Stock update failed"});}
});

app.delete("/api/products/:id",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id);if(!id)return res.status(400).json({success:false,message:"Invalid product id"});
    const r=await db.collection("products").deleteOne({_id:id});
    if(!r.deletedCount)return res.status(404).json({success:false,message:"Product nahi mila"});
    res.json({success:true,message:"Product deleted"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Product delete failed"});}
});

app.post("/api/orders",async(req,res)=>{
  try{
    const incoming=req.body||{};
    if(!Array.isArray(incoming.items)||!incoming.items.length)return res.status(400).json({success:false,message:"Cart empty hai"});
    if(!["Cash on Delivery","Online Payment"].includes(incoming.paymentMethod))return res.status(400).json({success:false,message:"Invalid payment method"});
    const c=incoming.customer||{};
    if(!c.name||!c.mobile||!c.address||!c.city||!c.pincode)return res.status(400).json({success:false,message:"Customer details incomplete"});
    if(!/^\d{10}$/.test(String(c.mobile)))return res.status(400).json({success:false,message:"Invalid mobile number"});
    if(!/^\d{6}$/.test(String(c.pincode)))return res.status(400).json({success:false,message:"Invalid pincode"});

    const items=[];
    let subtotal=0;
    for(const raw of incoming.items){
      const id=oid(raw.productId);
      if(!id)return res.status(400).json({success:false,message:`${raw.name||"Product"} ka product ID invalid hai`});
      const product=await db.collection("products").findOne({_id:id});
      if(!product)return res.status(400).json({success:false,message:`${raw.name||"Product"} product nahi mila`});
      const qty=Number(raw.quantity);
      if(!Number.isInteger(qty)||qty<1)return res.status(400).json({success:false,message:"Invalid quantity"});
      const updated=await db.collection("products").updateOne({_id:id,stock:{$gte:qty}},{$inc:{stock:-qty}});
      if(!updated.modifiedCount){
        for(const done of items)await db.collection("products").updateOne({_id:oid(done.productId)},{$inc:{stock:done.quantity}});
        return res.status(409).json({success:false,message:`${product.name} ka requested stock available nahi hai`});
      }
      items.push({productId:id.toString(),name:product.name,price:Number(product.price),quantity:qty,sellerId:product.sellerId?.toString?.()||"",sellerName:product.sellerName||"",sellerShopName:product.sellerShopName||"",sellerCity:product.sellerCity||""});
      subtotal+=Number(product.price)*qty;
    }
    const delivery=subtotal<300?30:0;
    const sellerStatuses={};
    const sellerTotals={};
    for(const item of items){
      if(item.sellerId){
        if(!sellerStatuses[item.sellerId]) sellerStatuses[item.sellerId]="New";
        sellerTotals[item.sellerId]=(sellerTotals[item.sellerId]||0)+(Number(item.price)||0)*(Number(item.quantity)||0);
      }
    }
    const commissionRate=await getCommissionRate();
    const sellerFinancials={};
    for(const [sellerId,amount] of Object.entries(sellerTotals)){
      const calc=commissionFor(amount,commissionRate);
      sellerFinancials[sellerId]={subtotal:Math.round(amount*100)/100,commissionRate,commission:calc.commission,netEarning:calc.net};
    }
    const order={orderNumber:"KS"+Date.now().toString(36).toUpperCase(),customer:{name:String(c.name).trim(),mobile:String(c.mobile),address:String(c.address).trim(),city:String(c.city).trim(),pincode:String(c.pincode)},items,total:subtotal+delivery,subtotal,delivery,paymentMethod:incoming.paymentMethod,status:"New",sellerStatuses,sellerFinancials,commissionRate,createdAt:new Date(),updatedAt:new Date()};
    try{
      const r=await db.collection("orders").insertOne(order);
      res.status(201).json({success:true,orderId:r.insertedId,orderNumber:order.orderNumber});
    }catch(err){
      for(const item of items)await db.collection("products").updateOne({_id:oid(item.productId)},{$inc:{stock:item.quantity}});
      throw err;
    }
  }catch(e){console.error("Order error:",e);res.status(500).json({success:false,message:"Order save failed"});}
});

// Seller orders: each seller only sees the items belonging to their own shop.
app.get("/api/sellers/orders",requireSeller,async(req,res)=>{
  try{
    const sellerId=String(req.seller._id);
    const orders=await db.collection("orders").find({"items.sellerId":sellerId}).sort({createdAt:-1,_id:-1}).toArray();
    const result=orders.map(order=>{
      const sellerItems=(order.items||[]).filter(item=>String(item.sellerId||"")===sellerId);
      const sellerSubtotal=sellerItems.reduce((sum,item)=>sum+(Number(item.price)||0)*(Number(item.quantity)||0),0);
      const savedFinancial=order.sellerFinancials?.[sellerId];
      const calc=savedFinancial||commissionFor(sellerSubtotal,Number(order.commissionRate)||DEFAULT_COMMISSION_RATE);
      return {
        _id:order._id,
        orderNumber:order.orderNumber,
        customer:order.customer,
        items:sellerItems,
        sellerSubtotal,
        commissionRate:Number(calc.commissionRate ?? order.commissionRate ?? DEFAULT_COMMISSION_RATE),
        commission:Number(calc.commission ?? 0),
        netEarning:Number(calc.netEarning ?? sellerSubtotal),
        paymentMethod:order.paymentMethod,
        status:order.sellerStatuses?.[sellerId] || order.status || "New",
        overallStatus:order.status || "New",
        createdAt:order.createdAt,
        updatedAt:order.updatedAt
      };
    });
    res.json({success:true,orders:result});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller orders fetch failed"});}
});

app.patch("/api/sellers/orders/:id/status",requireSeller,async(req,res)=>{
  try{
    const id=oid(req.params.id),newStatus=String(req.body?.status||"");
    const allowed=["Confirmed","Packed","Shipped","Delivered"];
    if(!id||!allowed.includes(newStatus))return res.status(400).json({success:false,message:"Invalid seller order status"});
    const order=await db.collection("orders").findOne({_id:id,"items.sellerId":String(req.seller._id)});
    if(!order)return res.status(404).json({success:false,message:"Aapka seller order nahi mila"});
    const key=String(req.seller._id);
    const current=order.sellerStatuses?.[key] || order.status || "New";
    const rank={New:0,Confirmed:1,Packed:2,Shipped:3,Delivered:4};
    if(current==="Delivered")return res.status(400).json({success:false,message:"Delivered order ka status change nahi kar sakte"});
    if(rank[newStatus] < (rank[current] ?? 0))return res.status(400).json({success:false,message:"Order status ko piche nahi kar sakte"});
    await db.collection("orders").updateOne({_id:id},{$set:{[`sellerStatuses.${key}`]:newStatus,updatedAt:new Date()}});
    res.json({success:true,message:"Seller order status updated successfully",status:newStatus});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller order status update failed"});}
});


// Seller payout & settlement ledger. Payouts are recorded manually by admin; no bank transfer is triggered.
app.get("/api/sellers/payouts",requireSeller,async(req,res)=>{
  try{
    const sellerId=String(req.seller._id);
    const orders=await db.collection("orders").find({"items.sellerId":sellerId}).sort({createdAt:-1,_id:-1}).toArray();
    const payoutDocs=await db.collection("payouts").find({sellerId}).sort({paidAt:-1,_id:-1}).toArray();
    const paidMap=new Map(payoutDocs.map(p=>[String(p.orderId),p]));
    let totalSales=0,totalCommission=0,totalNet=0,eligible=0,pending=0,paid=0,processing=0;
    const rows=orders.map(order=>{
      const items=(order.items||[]).filter(i=>String(i.sellerId||"")===sellerId);
      const subtotal=items.reduce((sum,i)=>sum+(Number(i.price)||0)*(Number(i.quantity)||0),0);
      if(!items.length)return null;
      const saved=order.sellerFinancials?.[sellerId];
      const calc=saved||commissionFor(subtotal,Number(order.commissionRate)||DEFAULT_COMMISSION_RATE);
      const net=Number(calc.netEarning||0), commission=Number(calc.commission||0);
      const status=order.sellerStatuses?.[sellerId]||order.status||"New";
      const payout=paidMap.get(String(order._id));
      const isCancelled=order.status==="Cancelled"||status==="Cancelled";
      totalSales+=isCancelled?0:subtotal; totalCommission+=isCancelled?0:commission; totalNet+=isCancelled?0:net;
      if(!isCancelled && status==="Delivered"){eligible+=net;if(payout)paid+=Number(payout.amount||net);else pending+=net;}
      else if(!isCancelled)processing+=net;
      return {_id:order._id,orderNumber:order.orderNumber,createdAt:order.createdAt,status,sellerSubtotal:subtotal,commissionRate:Number(calc.commissionRate??order.commissionRate??DEFAULT_COMMISSION_RATE),commission,netEarning:net,payoutStatus:payout?"Paid":(isCancelled?"Cancelled":status==="Delivered"?"Pending Payout":"Not Eligible"),paidAt:payout?.paidAt||null,payoutReference:payout?.reference||""};
    }).filter(Boolean);
    res.json({success:true,summary:{totalSales,totalCommission,totalNet,eligibleEarnings:eligible,paidPayout:paid,pendingPayout:pending,processingEarnings:processing},payouts:rows});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Seller payout data fetch failed"});}
});

app.get("/api/admin/payouts",requireAdmin,async(req,res)=>{
  try{
    const [sellers,orders,payouts]=await Promise.all([
      db.collection("sellers").find({}).project({password:0}).toArray(),
      db.collection("orders").find({}).sort({createdAt:-1,_id:-1}).toArray(),
      db.collection("payouts").find({}).sort({paidAt:-1,_id:-1}).toArray()
    ]);
    const sellerMap=new Map(sellers.map(s=>[String(s._id),s]));
    const paidMap=new Map(payouts.map(p=>[String(p.sellerId)+"_"+String(p.orderId),p]));
    const rows=[];
    for(const order of orders){
      for(const sellerId of Object.keys(order.sellerFinancials||{})){
        const items=(order.items||[]).filter(i=>String(i.sellerId||"")===sellerId);
        if(!items.length)continue;
        const saved=order.sellerFinancials?.[sellerId]||{};
        const status=order.sellerStatuses?.[sellerId]||order.status||"New";
        const isCancelled=order.status==="Cancelled"||status==="Cancelled";
        const key=sellerId+"_"+String(order._id), payout=paidMap.get(key);
        rows.push({orderId:String(order._id),orderNumber:order.orderNumber,sellerId,sellerName:sellerMap.get(sellerId)?.name||saved.sellerName||"Seller",shopName:sellerMap.get(sellerId)?.shopName||saved.sellerShopName||"",sellerMobile:sellerMap.get(sellerId)?.mobile||"",status,sellerSubtotal:Number(saved.subtotal||0),commissionRate:Number(saved.commissionRate??order.commissionRate??DEFAULT_COMMISSION_RATE),commission:Number(saved.commission||0),netEarning:Number(saved.netEarning||0),payoutStatus:payout?"Paid":(isCancelled?"Cancelled":status==="Delivered"?"Pending Payout":"Not Eligible"),paidAt:payout?.paidAt||null,reference:payout?.reference||"",createdAt:order.createdAt});
      }
    }
    const pending=rows.filter(r=>r.payoutStatus==="Pending Payout");
    const paid=rows.filter(r=>r.payoutStatus==="Paid");
    res.json({success:true,summary:{pendingPayout:pending.reduce((s,r)=>s+r.netEarning,0),paidPayout:paid.reduce((s,r)=>s+r.netEarning,0),pendingCount:pending.length,paidCount:paid.length},payouts:rows});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Payout data fetch failed"});}
});

app.post("/api/admin/payouts/:orderId/pay",requireAdmin,async(req,res)=>{
  try{
    const orderId=oid(req.params.orderId), sellerId=String(req.body?.sellerId||"");
    if(!orderId||!sellerId)return res.status(400).json({success:false,message:"Order aur seller required"});
    const order=await db.collection("orders").findOne({_id:orderId});
    if(!order)return res.status(404).json({success:false,message:"Order nahi mila"});
    const sellerStatus=order.sellerStatuses?.[sellerId]||order.status||"New";
    if(order.status==="Cancelled"||sellerStatus==="Cancelled")return res.status(400).json({success:false,message:"Cancelled order ka payout nahi ho sakta"});
    if(sellerStatus!=="Delivered")return res.status(400).json({success:false,message:"Payout sirf Delivered seller order par ho sakta hai"});
    const seller=await db.collection("sellers").findOne({_id:oid(sellerId)},{projection:{password:0}});
    if(!seller)return res.status(404).json({success:false,message:"Seller nahi mila"});
    const saved=order.sellerFinancials?.[sellerId];
    const items=(order.items||[]).filter(i=>String(i.sellerId||"")===sellerId);
    if(!items.length)return res.status(400).json({success:false,message:"Seller ka item is order mein nahi hai"});
    const subtotal=saved?.subtotal??items.reduce((sum,i)=>sum+(Number(i.price)||0)*(Number(i.quantity)||0),0);
    const rate=Number(saved?.commissionRate??order.commissionRate??DEFAULT_COMMISSION_RATE);
    const calc=saved||commissionFor(subtotal,rate);
    const amount=Number(calc.netEarning||commissionFor(subtotal,rate).net);
    const existing=await db.collection("payouts").findOne({sellerId,orderId});
    if(existing)return res.status(409).json({success:false,message:"Is order ka payout pehle hi mark ho chuka hai"});
    const reference=String(req.body?.reference||"").trim().slice(0,100);
    await db.collection("payouts").insertOne({sellerId,orderId,orderNumber:order.orderNumber,amount,subtotal:Number(subtotal),commission:Number(calc.commission||0),commissionRate:rate,status:"Paid",reference,paidAt:new Date(),createdAt:new Date()});
    res.json({success:true,message:`₹${amount.toLocaleString("en-IN")} payout marked as paid`,amount});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Payout mark failed"});}
});

app.get("/api/orders",requireAdmin,async(req,res)=>{
  try{const orders=await db.collection("orders").find({}).sort({createdAt:-1}).toArray();res.json({success:true,orders});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Orders fetch failed"});}
});

app.get("/api/orders/customer/:mobile",async(req,res)=>{
  try{const orders=await db.collection("orders").find({"customer.mobile":req.params.mobile}).sort({createdAt:-1}).toArray();res.json({success:true,orders});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Customer orders load nahi ho pa rahe"});}
});

app.get("/api/orders/track/:orderNumber",async(req,res)=>{
  try{const order=await db.collection("orders").findOne({orderNumber:req.params.orderNumber});if(!order)return res.status(404).json({success:false,message:"Order nahi mila"});res.json({success:true,order});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Order tracking failed"});}
});

async function restoreOrderStock(order){
  if(order.stockRestored)return;
  for(const item of order.items||[]){
    const id=oid(item.productId);
    if(id)await db.collection("products").updateOne({_id:id},{$inc:{stock:Number(item.quantity)}});
  }
}

app.patch("/api/orders/:id/status",requireAdmin,async(req,res)=>{
  try{
    const id=oid(req.params.id),newStatus=req.body.status;
    const allowed=["New","Confirmed","Packed","Shipped","Delivered","Cancelled"];
    if(!id||!allowed.includes(newStatus))return res.status(400).json({success:false,message:"Invalid status"});
    const order=await db.collection("orders").findOne({_id:id});if(!order)return res.status(404).json({success:false,message:"Order nahi mila"});
    if(order.status==="Cancelled"&&newStatus!=="Cancelled")return res.status(400).json({success:false,message:"Cancelled order ko reopen nahi kar sakte"});
    if(newStatus==="Cancelled"&&order.status!=="Cancelled"&&order.paymentMethod==="Cash on Delivery"){
      await restoreOrderStock(order);
      await db.collection("orders").updateOne({_id:id},{$set:{status:"Cancelled",stockRestored:true,cancelledAt:new Date(),updatedAt:new Date()}});
    }else{
      await db.collection("orders").updateOne({_id:id},{$set:{status:newStatus,updatedAt:new Date()}});
    }
    res.json({success:true,message:"Order status updated successfully"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Status update failed"});}
});

app.delete("/api/orders/:id",async(req,res)=>{
  try{
    const id=oid(req.params.id),mobile=String(req.body?.mobile||"");
    if(!id)return res.status(400).json({success:false,message:"Invalid order id"});
    const order=await db.collection("orders").findOne({_id:id,"customer.mobile":mobile});
    if(!order)return res.status(404).json({success:false,message:"Order nahi mila"});
    if(order.paymentMethod==="Online Payment")return res.status(400).json({success:false,message:"Online Payment order customer cancel nahi kar sakta."});
    if(!["Pending","New","Confirmed"].includes(order.status))return res.status(400).json({success:false,message:"Is stage par order cancel nahi ho sakta."});
    await restoreOrderStock(order);
    await db.collection("orders").updateOne({_id:id,status:{$in:["Pending","New","Confirmed"]}},{$set:{status:"Cancelled",stockRestored:true,cancelledAt:new Date(),updatedAt:new Date()}});
    res.json({success:true,message:"Order successfully cancelled aur stock restore ho gaya."});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Order cancel nahi ho paaya"});}
});

app.post("/api/customers/signup",async(req,res)=>{
  try{
    const {name,mobile,password,city}=req.body||{};
    if(!name||!mobile||!password||!city)return res.status(400).json({success:false,message:"Sabhi details required hain"});
    if(!/^\d{10}$/.test(String(mobile)))return res.status(400).json({success:false,message:"Valid 10 digit mobile number required"});
    if(String(password).length<6)return res.status(400).json({success:false,message:"Password at least 6 characters ka hona chahiye"});
    if(await db.collection("customers").findOne({mobile:String(mobile)}))return res.status(400).json({success:false,message:"Ye mobile number already registered hai"});
    const hash=await bcrypt.hash(String(password),10);
    await db.collection("customers").insertOne({name:String(name).trim(),mobile:String(mobile),password:hash,city:String(city).trim(),address:"",pincode:"",createdAt:new Date()});
    res.status(201).json({success:true,message:"Account successfully created"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Signup failed"});}
});

app.post("/api/customers/login",async(req,res)=>{
  try{
    const {mobile,password}=req.body||{}, customer=await db.collection("customers").findOne({mobile:String(mobile||"")});
    if(!customer)return res.status(401).json({success:false,message:"Mobile number registered nahi hai"});
    let valid=false;
    if(String(customer.password||"").startsWith("$2"))valid=await bcrypt.compare(String(password||""),customer.password);
    else if(customer.password===password){valid=true;await db.collection("customers").updateOne({_id:customer._id},{$set:{password:await bcrypt.hash(String(password),10)}});}
    if(!valid)return res.status(401).json({success:false,message:"Password galat hai"});
    res.json({success:true,message:"Login successful",customer:{name:customer.name,mobile:customer.mobile,city:customer.city||"",address:customer.address||"",pincode:customer.pincode||""}});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Login failed"});}
});

app.put("/api/customers/update",async(req,res)=>{
  try{
    const {mobile,name,city,address,pincode}=req.body||{};
    if(!mobile||!name||!city||!address||!/^\d{6}$/.test(String(pincode)))return res.status(400).json({success:false,message:"Name, city, address aur valid pincode required"});
    const r=await db.collection("customers").updateOne({mobile:String(mobile)},{$set:{name:String(name).trim(),city:String(city).trim(),address:String(address).trim(),pincode:String(pincode),updatedAt:new Date()}});
    if(!r.matchedCount)return res.status(404).json({success:false,message:"Customer nahi mila"});
    res.json({success:true,message:"Profile updated successfully"});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Profile update failed"});}
});

app.get("/api/reviews/:productId/rating",async(req,res)=>{
  try{
    const r=await db.collection("reviews").aggregate([{$match:{productId:req.params.productId}},{$group:{_id:null,averageRating:{$avg:"$rating"},totalReviews:{$sum:1}}}]).toArray();
    res.json({success:true,averageRating:r.length?Number(r[0].averageRating.toFixed(1)):0,totalReviews:r.length?r[0].totalReviews:0});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Average rating fetch failed"});}
});

app.get("/api/reviews/:productId",async(req,res)=>{
  try{const reviews=await db.collection("reviews").find({productId:req.params.productId}).sort({createdAt:-1}).toArray();res.json({success:true,reviews});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Reviews fetch failed"});}
});

app.post("/api/reviews",async(req,res)=>{
  try{
    const {productId,customerName,customerMobile,rating,review}=req.body||{}, r=Number(rating);
    if(!productId||!customerName||!customerMobile||!Number.isInteger(r)||r<1||r>5||!String(review||"").trim())return res.status(400).json({success:false,message:"Valid review details required"});
    const purchased=await db.collection("orders").findOne({"customer.mobile":String(customerMobile),status:"Delivered","items.productId":String(productId)});
    if(!purchased)return res.status(403).json({success:false,message:"Sirf delivered purchased products par review de sakte hain."});
    if(await db.collection("reviews").findOne({productId:String(productId),customerMobile:String(customerMobile)}))return res.status(400).json({success:false,message:"Aap is product ka review pehle hi de chuke hain."});
    const result=await db.collection("reviews").insertOne({productId:String(productId),customerName:String(customerName),customerMobile:String(customerMobile),rating:r,review:String(review).trim(),createdAt:new Date()});
    res.status(201).json({success:true,message:"Review saved successfully",reviewId:result.insertedId});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Review save failed"});}
});

app.get("/api/admin/reviews",requireAdmin,async(req,res)=>{
  try{const reviews=await db.collection("reviews").find({}).sort({createdAt:-1}).toArray();res.json({success:true,reviews});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Reviews fetch failed"});}
});

app.delete("/api/reviews/:id",requireAdmin,async(req,res)=>{
  try{const id=oid(req.params.id);if(!id)return res.status(400).json({success:false,message:"Invalid review id"});const r=await db.collection("reviews").deleteOne({_id:id});if(!r.deletedCount)return res.status(404).json({success:false,message:"Review nahi mila"});res.json({success:true,message:"Review deleted successfully"});}
  catch(e){console.error(e);res.status(500).json({success:false,message:"Review delete failed"});}
});

async function start(){
  try{
    await client.connect();
    db=client.db("khetse");
    await db.collection("orders").createIndex({orderNumber:1},{unique:true,sparse:true});
    await db.collection("customers").createIndex({mobile:1},{unique:true,sparse:true});
    await db.collection("sellers").createIndex({mobile:1},{unique:true,sparse:true});
    await db.collection("sellerSessions").createIndex({tokenHash:1},{unique:true,sparse:true});
    await db.collection("sellerSessions").createIndex({expiresAt:1},{expireAfterSeconds:0});
    await db.collection("payouts").createIndex({sellerId:1,orderId:1},{unique:true});
    await db.collection("payouts").createIndex({paidAt:-1});
    console.log("✅ MongoDB Connected Successfully!");
    app.listen(PORT,()=>console.log(`🌾 KhetSe server running at http://localhost:${PORT}`));
  }catch(e){console.error("❌ MongoDB Connection Failed:",e);}
}
start();
