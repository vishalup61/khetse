let cart = JSON.parse(localStorage.getItem("khetSeCart") || "[]");
let allProducts = [];
let activeCategory = "all";
let savedAddresses = [];
let editingAddressIndex = -1;

const $ = id => document.getElementById(id);
const money = n => "₹" + Number(n || 0).toLocaleString("en-IN");

function customer(){
  try{return JSON.parse(localStorage.getItem("khetSeCustomer") || "null");}catch{return null;}
}

function getAddressStorageKey(){
  const c = customer();
  return c ? `khetseSavedAddresses_${c.mobile}` : "khetseSavedAddresses";
}

function escapeHtml(v){
  return String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
function escapeAttr(v){return escapeHtml(v);}

async function api(url, options={}){
  const res = await fetch(url,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  let data={};
  try{data=await res.json();}catch{}
  if(!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

document.addEventListener("DOMContentLoaded",()=>{
  updateCart();
  loadProducts();
  refreshCustomerUI();
  loadSavedAddresses();
  if(location.hash==="#orders") loadMyOrders();
});

async function loadProducts(){
  try{
    const data=await api("/api/products");
    allProducts=data.products||[];
    renderProducts();
  }catch(e){
    $("products-container").innerHTML=`<div class="empty">Products load nahi ho pa rahe. Thodi der baad try karein.</div>`;
  }
}

function normalizeCategory(v){
  v=String(v||"other").toLowerCase();
  if(v.includes("atta")||v.includes("grain")) return "atta";
  if(v.includes("dal")||v.includes("pulse")||v.includes("chana")) return "dal";
  if(v.includes("honey")) return "honey";
  if(v.includes("achar")||v.includes("pickle")) return "pickle";
  return "other";
}

function renderProducts(){
  const q=($("product-search-input")?.value||"").trim().toLowerCase();
  const filtered=allProducts.filter(p=>{
    const catOk=activeCategory==="all"||normalizeCategory(p.category)===activeCategory;
    const text=`${p.name||""} ${p.description||""} ${p.category||""}`.toLowerCase();
    return catOk&&text.includes(q);
  });
  if(!filtered.length){$("products-container").innerHTML=`<div class="empty">Is category mein abhi product nahi mila.</div>`;return;}
  $("products-container").innerHTML=filtered.map(p=>{
    const id=String(p._id);
    const img=p.image?`<img src="${escapeAttr(p.image)}" alt="${escapeAttr(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">`:"";
    return `<article class="product-card">
      ${p.badge?`<span class="badge">${escapeHtml(p.badge)}</span>`:""}
      <div class="product-image">${img}<span class="fallback" style="${p.image?'display:none':''}">🌾</span></div>
      <div class="product-info">
        <h3>${escapeHtml(p.name)}</h3>
        ${p.sellerShopName?`<small class="seller-line">🏪 ${escapeHtml(p.sellerShopName)}${p.sellerCity?` · ${escapeHtml(p.sellerCity)}`:""}</small>`:""}
        <p>${escapeHtml(p.description||"Freshly packed Purez product.")}</p>
        <div class="price-row"><span class="price">${money(p.price)}</span><span class="stock">${Number(p.stock)>0?Number(p.stock)+" in stock":"Out of stock"}</span></div>
        <button class="add-btn" ${Number(p.stock)<=0?"disabled":""} onclick="addToCart('${id}')">${Number(p.stock)>0?"Add to cart":"Out of stock"}</button>
        <button class="text-btn detail-link" onclick="openProduct('${id}')">View details →</button>
      </div>
    </article>`;
  }).join("");
}

function addToCart(id){
  const p=allProducts.find(x=>String(x._id)===String(id));
  if(!p||Number(p.stock)<=0)return;
  const existing=cart.find(x=>x.productId===String(p._id));
  if(existing){
    if(existing.quantity>=Number(p.stock))return alert("Itna stock available nahi hai.");
    existing.quantity++;
  }else cart.push({productId:String(p._id),name:p.name,price:Number(p.price),quantity:1});
  saveCart();updateCart();
}
function saveCart(){localStorage.setItem("khetSeCart",JSON.stringify(cart));}
function cartTotals(){
  const subtotal=cart.reduce((s,i)=>s+Number(i.price)*Number(i.quantity),0);
  const cfg=window.KHETSE_CONFIG?.delivery||{}; const freeAbove=Number(cfg.freeAbove??300); const standardCharge=Number(cfg.standardCharge??30); const delivery=subtotal>0&&subtotal<freeAbove?standardCharge:0;
  return {subtotal,delivery,total:subtotal+delivery};
}
function updateCart(){
  const {subtotal,delivery,total}=cartTotals();
  if($("cart-count"))$("cart-count").textContent=cart.reduce((s,i)=>s+Number(i.quantity),0);
  if($("cart-subtotal"))$("cart-subtotal").textContent=money(subtotal);
  if($("cart-delivery"))$("cart-delivery").textContent=delivery?money(delivery):"FREE";
  if($("cart-total"))$("cart-total").textContent=money(total);
  const box=$("cart-items");if(!box)return;
  box.innerHTML=cart.length?cart.map((i,n)=>`<div class="cart-row"><div><strong>${escapeHtml(i.name)}</strong><br><small>${money(i.price)} each</small></div><div class="qty"><button onclick="changeQty(${n},-1)">−</button><b>${i.quantity}</b><button onclick="changeQty(${n},1)">+</button></div><button class="remove" onclick="removeCart(${n})">Remove</button></div>`).join(""):`<div class="empty">Cart empty hai 🛒</div>`;
}
function changeQty(index,delta){
  const item=cart[index];if(!item)return;
  const p=allProducts.find(x=>String(x._id)===String(item.productId));
  const next=item.quantity+delta;
  if(next<1)return removeCart(index);
  if(p&&next>Number(p.stock))return alert("Available stock se zyada quantity nahi le sakte.");
  item.quantity=next;saveCart();updateCart();
}
function removeCart(index){cart.splice(index,1);saveCart();updateCart();}
function openCart(){$("cart-modal").style.display="block";updateCart();}
function closeCart(){$("cart-modal").style.display="none";}

function populateCheckoutAddresses(){
  const select=$("checkout-address-select");if(!select)return;
  select.innerHTML=`<option value="">Select saved address</option>`+savedAddresses.map((a,i)=>`<option value="${i}">${escapeHtml(a.type)}${a.isDefault?" — Default":""} · ${escapeHtml(a.city)}</option>`).join("");
  const def=savedAddresses.findIndex(a=>a.isDefault);
  if(def>=0){select.value=String(def);selectSavedAddress(String(def));}
}
function selectSavedAddress(value){
  if(value==="")return;
  const a=savedAddresses[Number(value)];if(!a)return;
  $("customer-address").value=a.address||"";
  $("customer-city").value=a.city||"";
  $("customer-pincode").value=a.pincode||"";
}

function openCheckout(){
  cart=JSON.parse(localStorage.getItem("khetSeCart")||"[]");
  if(!cart.length)return alert("Cart empty hai! Pehle product add karo 🛒");
  const c=customer();
  if(!c){alert("Checkout ke liye pehle Login karo 🔐");openLogin();return;}
  $("customer-name").value=c.name||"";
  $("customer-mobile").value=c.mobile||"";
  $("customer-address").value=c.address||"";
  $("customer-city").value=c.city||"";
  $("customer-pincode").value=c.pincode||"";
  populateCheckoutAddresses();
  closeCart();updateCheckout();$("order-success").hidden=true;$(`checkout-modal`).style.display="block";
}
function closeCheckout(){$("checkout-modal").style.display="none";}
function updateCheckout(){
  const {subtotal,delivery,total}=cartTotals();
  $("checkout-subtotal").textContent=money(subtotal);$("checkout-delivery").textContent=delivery?money(delivery):"FREE";$("checkout-total").textContent=money(total);
  $("checkout-items").innerHTML=cart.map(i=>`<div class="checkout-item"><span>${escapeHtml(i.name)} × ${i.quantity}</span><strong>${money(i.price*i.quantity)}</strong></div>`).join("");
}

async function placeOrder(e){
  e.preventDefault();
  const name=$("customer-name").value.trim(),mobile=$("customer-mobile").value.trim(),address=$("customer-address").value.trim(),city=$("customer-city").value.trim(),pincode=$("customer-pincode").value.trim();
  const paymentMethod=document.querySelector('input[name="payment"]:checked')?.value;
  if(!name||!mobile||!address||!city||!pincode)return alert("Please saari details fill karo.");
  if(!/^\d{10}$/.test(mobile))return alert("Valid 10 digit mobile number enter karo.");
  if(!/^\d{6}$/.test(pincode))return alert("Valid pincode enter karo.");
  if(!paymentMethod)return alert("Payment method select karo.");
  const {total}=cartTotals();
  const orderData={customer:{name,mobile,address,city,pincode},items:cart.map(x=>({...x})),total,paymentMethod};
  try{
    const result=await api("/api/orders",{method:"POST",body:JSON.stringify(orderData)});
    localStorage.setItem("khetSeOrderNumber",result.orderNumber);
    localStorage.setItem("khetSeLastOrder",JSON.stringify({...orderData,orderNumber:result.orderNumber,status:"New"}));
    $("order-success").hidden=false;
    $("order-success").innerHTML=`<strong>🎉 Order placed successfully!</strong><br>Order ID: <b>${escapeHtml(result.orderNumber)}</b><br>Total: <b>${money(total)}</b><br><br><button class="btn ghost" onclick="closeCheckout();location.hash='orders';loadMyOrders()">View My Orders</button>`;
    cart=[];saveCart();updateCart();loadProducts();
  }catch(err){alert(err.message);}
}

async function loadMyOrders(){
  const c=customer(),box=$("orders-container");if(!box)return;
  if(!c){box.innerHTML=`<div class="empty">My Orders dekhne ke liye <button class="text-btn" onclick="openLogin()">Login</button> karo.</div>`;return;}
  try{
    const data=await api("/api/orders/customer/"+encodeURIComponent(c.mobile));const orders=data.orders||[];
    if(!orders.length){box.innerHTML=`<div class="empty">Abhi koi order nahi hai.</div>`;return;}
    box.innerHTML=orders.map(order=>{
      const cancellable=["Pending","New","Confirmed"].includes(order.status)&&order.paymentMethod==="Cash on Delivery";
      const statuses=["New","Confirmed","Packed","Shipped","Delivered"],idx=statuses.indexOf(order.status);
      const timeline=statuses.map((s,i)=>`<div class="step ${idx>=i?"done":""}"><i></i>${s}</div>`).join("");
      const reviewable=order.status==="Delivered";
      const reviewButtons=reviewable?(order.items||[]).map(i=>`<button class="text-btn" onclick="openProduct('${escapeAttr(i.productId)}')">Review ${escapeHtml(i.name)} →</button>`).join(""):"";
      return `<article class="order-card"><div class="order-top"><div><div class="order-id">🆔 ${escapeHtml(order.orderNumber||String(order._id))}</div><small>${new Date(order.createdAt).toLocaleString("en-IN")}</small></div><span class="status-pill">${escapeHtml(order.status||"New")}</span></div><div class="order-items">${(order.items||[]).map(i=>`<div class="order-item"><span>${escapeHtml(i.name)} × ${i.quantity}</span><strong>${money(i.price*i.quantity)}</strong></div>`).join("")}</div>${order.status!=="Cancelled"?`<div class="timeline">${timeline}</div>`:""}<div class="order-top"><strong>Total ${money(order.total)}</strong><small>${escapeHtml(order.paymentMethod||"")}</small></div><div class="order-actions">${cancellable?`<button class="danger-btn" onclick="cancelCustomerOrder('${order._id}')">Cancel Order</button>`:""}<button class="btn ghost" onclick="trackOrder('${escapeAttr(order.orderNumber)}')">Track</button></div>${reviewButtons?`<div class="review-order-actions"><strong>Delivered? Share your experience:</strong>${reviewButtons}</div>`:""}</article>`;
    }).join("");
  }catch(err){box.innerHTML=`<div class="empty">${escapeHtml(err.message)}</div>`;}
}
async function cancelCustomerOrder(id){
  if(!confirm("Order cancel karna hai?"))return;
  const c=customer();
  try{await api("/api/orders/"+id,{method:"DELETE",body:JSON.stringify({mobile:c.mobile})});alert("Order cancelled aur stock restore ho gaya.");loadMyOrders();loadProducts();}catch(e){alert(e.message);}
}
async function trackOrder(number){
  if(!number)return;
  try{const d=await api("/api/orders/track/"+encodeURIComponent(number));const o=d.order;alert(`Order ${o.orderNumber}\nStatus: ${o.status}\nTotal: ${money(o.total)}`);loadMyOrders();}catch(e){alert(e.message);}
}

function refreshCustomerUI(){
  const c=customer();
  $("account-btn").innerHTML=c?`👤 <span>${escapeHtml(c.name.split(" ")[0])}</span>`:"👤 <span>Login</span>";
  if(c){
    $("account").hidden=false;$("account-name").textContent=c.name;$("profile-name").value=c.name;$("profile-mobile").value=c.mobile;$("profile-city").value=c.city||"";$("profile-address").value=c.address||"";$("profile-pincode").value=c.pincode||"";
  }else $("account").hidden=true;
}
function openLogin(){showAuth("login");$("auth-modal").style.display="block";}
function closeAuth(){$("auth-modal").style.display="none";}
function showAuth(type){
  $("login-form").hidden=type!=="login";$("signup-form").hidden=type!=="signup";$("login-tab").classList.toggle("active",type==="login");$("signup-tab").classList.toggle("active",type==="signup");
}
async function loginCustomer(e){
  e.preventDefault();const msg=$("login-msg");msg.textContent="";
  try{
    const d=await api("/api/customers/login",{method:"POST",body:JSON.stringify({mobile:$("login-mobile").value.trim(),password:$("login-password").value})});
    localStorage.setItem("khetSeCustomer",JSON.stringify(d.customer));refreshCustomerUI();loadSavedAddresses();closeAuth();alert("Login successful 👋");loadMyOrders();
  }catch(x){msg.textContent=x.message;}
}
async function signupCustomer(e){
  e.preventDefault();const msg=$("signup-msg");msg.textContent="";
  try{await api("/api/customers/signup",{method:"POST",body:JSON.stringify({name:$("signup-name").value.trim(),mobile:$("signup-mobile").value.trim(),city:$("signup-city").value.trim(),password:$("signup-password").value})});alert("Account successfully created. Ab login karo.");showAuth("login");$("login-mobile").value=$("signup-mobile").value.trim();}catch(x){msg.textContent=x.message;}
}
function logoutCustomer(){localStorage.removeItem("khetSeCustomer");savedAddresses=[];renderSavedAddresses();refreshCustomerUI();loadMyOrders();location.hash="home";}
async function updateProfile(e){
  e.preventDefault();const c=customer();if(!c)return;
  try{await api("/api/customers/update",{method:"PUT",body:JSON.stringify({mobile:c.mobile,name:$("profile-name").value.trim(),city:$("profile-city").value.trim(),address:$("profile-address").value.trim(),pincode:$("profile-pincode").value.trim()})});localStorage.setItem("khetSeCustomer",JSON.stringify({...c,name:$("profile-name").value.trim(),city:$("profile-city").value.trim(),address:$("profile-address").value.trim(),pincode:$("profile-pincode").value.trim()}));refreshCustomerUI();alert("Profile updated successfully");}catch(x){alert(x.message);}
}

function openAddressForm(index=-1){
  if(!customer()){alert("Saved address ke liye pehle login karo.");openLogin();return;}
  editingAddressIndex=index;
  $("address-form-title").textContent=index>=0?"Edit Address":"Add Address";
  if(index>=0){const a=savedAddresses[index];$("address-type").value=a.type||"Home";$("address-text").value=a.address||"";$("address-city").value=a.city||"";$("address-pincode").value=a.pincode||"";$("address-default").checked=!!a.isDefault;}
  else{$("address-form").reset();$("address-type").value="Home";$("address-default").checked=savedAddresses.length===0;}
  $("address-modal").style.display="block";
}
function closeAddressForm(){$("address-modal").style.display="none";editingAddressIndex=-1;}
function saveAddress(event){
  event.preventDefault();
  const address={type:$("address-type").value,address:$("address-text").value.trim(),city:$("address-city").value.trim(),pincode:$("address-pincode").value.trim(),isDefault:$("address-default").checked};
  if(!address.address||!address.city||!/^[0-9]{6}$/.test(address.pincode))return alert("Address, city aur valid 6 digit pincode required.");
  if(address.isDefault)savedAddresses.forEach(a=>a.isDefault=false);
  if(editingAddressIndex>=0)savedAddresses[editingAddressIndex]=address;else savedAddresses.push(address);
  if(savedAddresses.length&&!savedAddresses.some(a=>a.isDefault))savedAddresses[0].isDefault=true;
  localStorage.setItem(getAddressStorageKey(),JSON.stringify(savedAddresses));
  renderSavedAddresses();closeAddressForm();
}
function loadSavedAddresses(){
  try{savedAddresses=JSON.parse(localStorage.getItem(getAddressStorageKey())||"[]");if(!Array.isArray(savedAddresses))savedAddresses=[];}catch{savedAddresses=[];}
  renderSavedAddresses();
}
function renderSavedAddresses(){
  const box=$("saved-addresses-container");if(!box)return;
  if(!customer()){box.innerHTML=`<div class="empty">Login karke apne addresses save karein.</div>`;return;}
  if(!savedAddresses.length){box.innerHTML=`<div class="empty">Abhi koi saved address nahi hai.</div>`;return;}
  box.innerHTML=savedAddresses.map((a,i)=>`<div class="saved-address-card"><div class="saved-address-top"><strong>${escapeHtml(a.type)}</strong>${a.isDefault?`<span class="badge inline-badge">DEFAULT</span>`:""}</div><p>${escapeHtml(a.address)}</p><p>${escapeHtml(a.city)} - ${escapeHtml(a.pincode)}</p><div class="address-actions"><button class="btn ghost" type="button" onclick="openAddressForm(${i})">Edit</button><button class="danger-btn" type="button" onclick="deleteAddress(${i})">Delete</button></div></div>`).join("");
}
function deleteAddress(index){
  if(!confirm("Ye address delete karna hai?"))return;
  savedAddresses.splice(index,1);
  if(savedAddresses.length&&!savedAddresses.some(a=>a.isDefault))savedAddresses[0].isDefault=true;
  localStorage.setItem(getAddressStorageKey(),JSON.stringify(savedAddresses));renderSavedAddresses();
}

function searchProducts(){renderProducts();}
function filterCategory(cat){activeCategory=cat||"all";$("category-select").value=activeCategory;renderProducts();location.hash="products";}
function toggleMenu(){$("main-nav").classList.toggle("open");}

async function openProduct(id){
  const p=allProducts.find(x=>String(x._id)===String(id));if(!p)return;
  const img=p.image?`<img src="${escapeAttr(p.image)}" alt="${escapeAttr(p.name)}">`:`<span class="fallback">🌾</span>`;
  let rating={averageRating:0,totalReviews:0},reviews=[];
  try{rating=await api("/api/reviews/"+id+"/rating");const d=await api("/api/reviews/"+id);reviews=d.reviews||[];}catch{}
  const c=customer();
  const reviewForm=c?`<div class="review-form"><h3>Rate this product</h3><p class="muted">Delivered order ke baad apna experience share karein.</p><form onsubmit="submitReview(event,'${escapeAttr(id)}')"><label>Rating<select id="review-rating" required><option value="">Select rating</option><option value="5">★★★★★ — Excellent</option><option value="4">★★★★ — Very good</option><option value="3">★★★ — Good</option><option value="2">★★ — Fair</option><option value="1">★ — Poor</option></select></label><label>Review<textarea id="review-text" minlength="3" maxlength="500" required placeholder="Aapko product kaisa laga?"></textarea></label><button class="btn primary" type="submit">Submit Review</button><p id="review-msg" class="form-msg"></p></form></div>`:`<p class="muted">Review dene ke liye customer login karein.</p>`;
  const reviewList=reviews.length?reviews.map(r=>`<div class="review-card"><div><strong>${"⭐".repeat(Number(r.rating))}</strong> <b>${escapeHtml(r.customerName)}</b></div><p>${escapeHtml(r.review)}</p><small>${new Date(r.createdAt).toLocaleDateString("en-IN")}</small></div>`).join(""):`<p class="muted">No reviews yet.</p>`;
  $("product-detail-content").innerHTML=`<div class="product-detail-grid"><div class="detail-img">${img}</div><div><span class="eyebrow">${escapeHtml(p.category||"PRODUCT")}</span><h2>${escapeHtml(p.name)}</h2><div class="detail-price">${money(p.price)}</div><p>${escapeHtml(p.description||"Freshly packed Purez product.")}</p><div class="rating-summary">⭐ <strong>${rating.averageRating||"No rating"}</strong> <span>(${rating.totalReviews||0} reviews)</span></div><p class="stock">${Number(p.stock)>0?Number(p.stock)+" available":"Out of stock"}</p><button class="btn primary wide" ${Number(p.stock)<=0?"disabled":""} onclick="addToCart('${escapeAttr(id)}');closeProduct();openCart()">Add to cart</button></div></div><hr><section class="reviews-section"><h3>Customer reviews</h3>${reviewList}${reviewForm}</section>`;
  $("product-modal").style.display="block";
}

async function submitReview(event,productId){
  event.preventDefault();const c=customer(),msg=$("review-msg");if(!c)return;
  msg.textContent="";
  try{await api("/api/reviews",{method:"POST",body:JSON.stringify({productId,customerName:c.name,customerMobile:c.mobile,rating:Number($("review-rating").value),review:$("review-text").value.trim()})});alert("Review submitted successfully ⭐");await openProduct(productId);}catch(e){msg.textContent=e.message;}
}
function closeProduct(){$("product-modal").style.display="none";}
window.addEventListener("click",e=>{if(e.target.classList.contains("modal"))e.target.style.display="none";});
