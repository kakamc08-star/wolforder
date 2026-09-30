const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname, '..');
const db=new PGlite();
const ids={admin:'10000000-0000-4000-8000-000000000001',company:'10000000-0000-4000-8000-000000000002',other:'10000000-0000-4000-8000-000000000003',viewer:'10000000-0000-4000-8000-000000000004',otherViewer:'10000000-0000-4000-8000-000000000005',driver:'10000000-0000-4000-8000-000000000006',product:'20000000-0000-4000-8000-000000000001',variant:'30000000-0000-4000-8000-000000000001',variant2:'30000000-0000-4000-8000-000000000002',otherProduct:'20000000-0000-4000-8000-000000000002',otherVariant:'30000000-0000-4000-8000-000000000003'};
const extract=(file,name)=>fs.readFileSync(path.join(root,'database',file),'utf8').match(new RegExp('create or replace function public\\.'+name+'\\([\\s\\S]*?\\n\\$\\$;'))[0];
async function row(sql,params=[]){return (await db.query(sql,params)).rows[0];}
async function rpc(name,params=[]){return (await row(`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) as result`,params)).result;}
async function stock(variant=ids.variant){return Number((await row('select stock_available from instagram_variants where id=$1',[variant])).stock_available);}
async function order(id){return row('select * from instagram_orders where id=$1',[id]);}
async function request(id,changes,actor=ids.viewer){return rpc('create_instagram_order_edit_request_atomic',[id,actor,changes,'اختبار تعديل']);}
async function decision(id,approve,actor=ids.admin){return rpc('decide_instagram_order_edit_request_atomic',[id,actor,approve,'تمت المراجعة']);}
async function create(type='شحن',quantity=2,key=randomUUID(),slug='test-link'){return rpc('create_instagram_order_atomic',[slug,'محمد أحمد محمود','0999999999','دمشق المزة',type,[{variant_id:ids.variant,quantity}],key,'']);}
let passed=0;
async function test(name,fn){await fn();console.log('PASS',name);passed++;}
(async()=>{
 await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/instagram-live-schema.sql'), 'utf8'));
 for(const [key,role,name] of [['admin','admin','أدمن'],['company','company','الشركة الأولى'],['other','company','الشركة الثانية'],['viewer','instagram_viewer','مشاهد'],['otherViewer','instagram_viewer','مشاهد آخر'],['driver','driver','سائق']]) await db.query('insert into users values($1,$2,$3,$4)',[ids[key],role,name,key]);
 await db.query('insert into orders values($1,$2,$3)',[randomUUID(),'شحن', {untouched:'النظام الأساسي'}]);
 await db.query('insert into instagram_products(id,company_id,name,unit_price,currency) values($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)',[ids.product,ids.company,'قميص',5000,'ل.س',ids.otherProduct,ids.other,'صنف شركة أخرى']);
 await db.query('insert into instagram_variants(id,product_id,color,size,stock_total,stock_available) values($1,$2,$3,$4,100,100),($5,$2,$3,$6,8,8),($7,$8,$3,$4,100,100)',[ids.variant,ids.product,'أسود','L',ids.variant2,'XL',ids.otherVariant,ids.otherProduct]);
 await db.query('insert into instagram_company_links(company_id,slug) values($1,$2),($3,$4)',[ids.company,'test-link',ids.other,'other-link']);
 await db.query('insert into instagram_viewer_companies values($1,$2),($3,$4)',[ids.viewer,ids.company,ids.otherViewer,ids.other]);
 for(const name of ['reserve_instagram_shipping_order_stock','create_instagram_order_atomic','approve_instagram_shipping_order_atomic','reject_instagram_shipping_order_atomic','delete_instagram_order_atomic']) await db.exec(extract('2026-09-05-instagram-shipping-pending-reservation.sql',name));
 await db.exec(extract('2026-09-04-instagram-shipping-workflow.sql','instagram_orders_shipping_driver_guard'));
 await db.exec('create trigger instagram_orders_shipping_driver_guard before insert or update of order_type, driver_id on public.instagram_orders for each row execute function public.instagram_orders_shipping_driver_guard()');
 const old=await create('شحن',2); const before=await stock();
 const baseSnapshot=await db.query('select * from orders');
 const migration=fs.readFileSync(path.join(root,'database/2026-09-30-instagram-direct-shipping-and-edit-requests.sql'),'utf8');
 const missingId=randomUUID(); const shortageId=randomUUID();
 for(const [id,number,quantity,created] of [[missingId,800,2,'2000-01-01'],[shortageId,801,200,'2010-01-01']]) {
   await db.query("insert into instagram_orders(id,order_number,company_id,company_name,customer_name,customer_number,address,order_type,status,shipping_approval_status,shipping_delivery_status,created_at,currency,total_price) values($1,$2,$3,'شركة','محمد أحمد محمود','0999999999','دمشق','شحن','قيد المتابعة','pending','pending',$4,'ل.س',20000)",[id,number,ids.company,created]);
   await db.query("insert into instagram_order_items(order_id,product_id,variant_id,product_name,color,size,unit_price,quantity) values($1,$2,$3,'قميص','أسود','L',5000,$4)",[id,ids.product,ids.variant,quantity]);
 }
 await test('legacy stock shortage aborts the entire migration without partial reservation',async()=>{
   await assert.rejects(db.exec(migration),/غير متوفرة/);await db.exec('rollback');assert.equal(await stock(),before);assert.equal((await order(missingId)).shipping_approval_status,'pending');
   await rpc('delete_instagram_order_atomic',[shortageId,ids.admin]);assert.equal(await stock(),before);
 });
 await test('migration executes and reserves legacy pending orders once',async()=>{await db.exec(migration);assert.equal(await stock(),before-2);assert.equal((await order(old.id)).shipping_approval_status,'accepted');assert.equal((await order(missingId)).shipping_approval_status,'accepted');});
 await test('migration is repeatable and normal orders stay intact',async()=>{await db.exec(migration);assert.equal(await stock(),before-2);assert.deepEqual((await db.query('select * from orders')).rows,baseSnapshot.rows);});
 const typeMigration=fs.readFileSync(path.join(root,'database/2026-09-30-instagram-order-type-edit.sql'),'utf8');
 await test('type-edit migration preserves pending legacy proposals and can be reapplied',async()=>{
   const legacy=await request(old.id,{note:'طلب سابق'});const count=await stock();
   await db.exec(typeMigration);await db.exec(typeMigration);
   const saved=await row('select original_values from instagram_order_edit_requests where id=$1',[legacy.id]);
   assert.equal(saved.original_values.order_type,'شحن');assert.equal(saved.original_values.shipping_fee,10000);
   await decision(legacy.id,true);assert.equal((await order(old.id)).note,'طلب سابق');assert.equal(await stock(),count);
 });
 // Simulate a deployed legacy overload with an optional fifteenth argument.
 await db.exec("create or replace function public.update_instagram_order_atomic(\n  p_order_id uuid,\n  p_actor_user_id uuid,\n  p_order_number bigint default null,\n  p_customer_name text default null,\n  p_customer_number text default null,\n  p_address text default null,\n  p_total_price numeric default null,\n  p_ratio numeric default null,\n  p_note text default null,\n  p_status text default null,\n  p_driver_id uuid default null,\n  p_company_id uuid default null,\n  p_items jsonb default null,\n  p_recalculate_total_price boolean default false,\n  p_order_type text default null\n)\nreturns jsonb language plpgsql as $$ begin raise exception 'Legacy overload must remain unused'; end; $$;");
 const edit=(id,changes,actor=ids.admin)=>rpc('edit_instagram_order_atomic',[id,actor,changes]);
 let shipped;
 await test('shipping is immediately recorded with the existing pending delivery state',async()=>{const prior=await stock();shipped=await create('شحن',3);assert.equal(shipped.shipping_delivery_status,'pending');assert.equal(await stock(),prior-3);assert.equal((await order(shipped.id)).shipping_approval_status,'accepted');assert.equal(Number(shipped.total_price),25000);});
 await test('idempotent public retry does not reserve twice',async()=>{const key=randomUUID();const x=await create('شحن',1,key);const prior=await stock();const retry=await create('شحن',1,key);assert.equal(retry.id,x.id);assert.equal(retry.duplicate,true);assert.equal(await stock(),prior);});
 await test('delivery moves shipping inventory bucket without changing stock',async()=>{const prior=await stock();const before=await row('select * from instagram_inventory_delivery_totals where size=$1 and product_id=$2',['L',ids.product]);const x=await rpc('mark_instagram_shipping_delivered_atomic',[[shipped.id],ids.admin]);assert.equal(x.delivered_count,1);const after=await row('select * from instagram_inventory_delivery_totals where size=$1 and product_id=$2',['L',ids.product]);assert.equal(Number(after.reserved_shipping),Number(before.reserved_shipping)-3);assert.equal(Number(after.shipping_delivered),Number(before.shipping_delivered)+3);assert.equal(await stock(),prior);assert.equal((await order(shipped.id)).shipping_delivered_to_name,'الشركة الأولى');});
 await test('two delivery states are reversible and duplicate delivery is harmless',async()=>{const prior=await stock();const x=await rpc('mark_instagram_shipping_delivered_atomic',[[shipped.id],ids.admin]);assert.equal(x.delivered_count,0);await rpc('set_instagram_shipping_delivery_status_atomic',[[shipped.id],'pending',ids.admin]);assert.equal((await order(shipped.id)).shipping_delivery_status,'pending');assert.equal(await stock(),prior);});
 await test('shipping cannot acquire general delivery statuses or a third delivery state',async()=>{await assert.rejects(rpc('change_instagram_order_status_atomic',[shipped.id,'تم',ids.admin,null]),/حالة|التسليم/);await assert.rejects(rpc('set_instagram_shipping_delivery_status_atomic',[[shipped.id],'third',ids.admin]),/غير صالحة/);await assert.rejects(db.query("update instagram_orders set status='إلغاء' where id=$1",[shipped.id]),/حالة التسليم/);});
 await test('existing Instagram delivery workflow continues to sell and release stock',async()=>{const d=await create('توصيل',2);await rpc('change_instagram_order_status_atomic',[d.id,'تم',ids.admin,null]);const totals=await row('select * from instagram_inventory_delivery_totals where size=$1 and product_id=$2',['L',ids.product]);assert.equal(Number(totals.sold_delivery),2);const prior=await stock();await rpc('change_instagram_order_status_atomic',[d.id,'مرتجع',ids.admin,null]);assert.equal(await stock(),prior+2);});
 await test('viewer proposal changes neither order data nor inventory',async()=>{const prior=await stock();const original=await order(shipped.id);const r=await request(shipped.id,{customer_number:'0988888888'});assert.equal(r.status,'معلق');assert.equal((await order(shipped.id)).customer_number,original.customer_number);assert.equal(await stock(),prior);shipped.requestId=r.id;});
 await test('duplicate proposal and cross-company viewer access are denied',async()=>{await assert.rejects(request(shipped.id,{note:'طلب آخر'}),/معلق/);await assert.rejects(request(old.id,{note:'شركة أخرى'},ids.otherViewer),/غير مصرح/);await assert.rejects(request(old.id,{company_id:ids.other}),/غير مسموحة/);});
 await test('only an admin can approve and metadata changes preserve stock/items',async()=>{const prior=await stock();const oldItems=(await db.query('select * from instagram_order_items where order_id=$1',[shipped.id])).rows;await assert.rejects(decision(shipped.requestId,true,ids.viewer),/غير مصرح/);await decision(shipped.requestId,true);assert.equal((await order(shipped.id)).customer_number,'0988888888');assert.equal(await stock(),prior);assert.deepEqual((await db.query('select * from instagram_order_items where order_id=$1',[shipped.id])).rows,oldItems);await assert.rejects(decision(shipped.requestId,true),/مسبقاً/);});
 await test('rejecting an edit proposal preserves original order and stock',async()=>{const r=await request(shipped.id,{address:'عنوان مقترح'});const prior=await order(shipped.id);const count=await stock();await decision(r.id,false);assert.deepEqual(await order(shipped.id),prior);assert.equal(await stock(),count);assert.equal((await row('select status from instagram_order_edit_requests where id=$1',[r.id])).status,'مرفوض');});
 await test('approved shipping item edits update quantities and preserve shipping fee',async()=>{const prior=await stock();const r=await request(shipped.id,{items:[{variant_id:ids.variant,quantity:4}],recalculate_total_price:true});assert.equal(await stock(),prior);await decision(r.id,true);assert.equal(await stock(),prior-1);const o=await order(shipped.id);assert.equal(Number(o.items_total),20000);assert.equal(Number(o.total_price),30000);assert.equal(Number(o.shipping_fee),10000);});
 await test('shortage at approval rolls back both order and request decision',async()=>{const r=await request(shipped.id,{items:[{variant_id:ids.variant2,quantity:9}],recalculate_total_price:true});const prior=await order(shipped.id);const count=await stock();await assert.rejects(decision(r.id,true),/غير متوفرة/);assert.equal(await stock(),count);assert.equal(await stock(ids.variant2),8);assert.deepEqual(await order(shipped.id),prior);assert.equal((await row('select status from instagram_order_edit_requests where id=$1',[r.id])).status,'معلق');await decision(r.id,false);});
 await test('stale proposal does not overwrite an admin change',async()=>{const r=await request(shipped.id,{address:'العنوان الجديد'});await db.query('update instagram_orders set address=$1 where id=$2',['تعديل أدمن لاحق',shipped.id]);await assert.rejects(decision(r.id,true),/تغيرت بيانات/);assert.equal((await order(shipped.id)).address,'تعديل أدمن لاحق');await decision(r.id,false);});
 await test('unrelated concurrent changes survive approval',async()=>{const r=await request(shipped.id,{customer_number:'0977777777'});await db.query('update instagram_orders set note=$1 where id=$2',['ملاحظة أدمن لاحقة',shipped.id]);await decision(r.id,true);const o=await order(shipped.id);assert.equal(o.customer_number,'0977777777');assert.equal(o.note,'ملاحظة أدمن لاحقة');});
 await test('shipping delivery change can also be requested and needs approval',async()=>{const r=await request(shipped.id,{shipping_delivery_status:'delivered'});assert.equal((await order(shipped.id)).shipping_delivery_status,'pending');const prior=await stock();await decision(r.id,true);assert.equal((await order(shipped.id)).shipping_delivery_status,'delivered');assert.equal(await stock(),prior);});
 await test('old shipping approve/reject RPCs are revoked, and browser roles cannot execute new mutations',async()=>{await db.exec('set role service_role');try{await assert.rejects(rpc('reject_instagram_shipping_order_atomic',[old.id,ids.viewer]),/permission denied/);await assert.rejects(rpc('approve_instagram_shipping_order_atomic',[old.id,ids.viewer]),/permission denied/);}finally{await db.exec('reset role');}await db.exec('set role authenticated');try{await assert.rejects(rpc('decide_instagram_order_edit_request_atomic',[shipped.requestId,ids.admin,true,'']),/permission denied/);await assert.rejects(db.query('select * from instagram_order_edit_requests'),/permission denied/);}finally{await db.exec('reset role');}});
 await test('hard deletion still restores exactly the shipping quantity after approved edits',async()=>{const prior=await stock();await rpc('delete_instagram_order_atomic',[shipped.id,ids.admin]);assert.equal(await stock(),prior+4);assert.equal(await order(shipped.id),undefined);});
 await test('delivery status-only edit approval preserves item snapshots and releases once',async()=>{
   const d=await create('توصيل',1);const originalItems=(await db.query('select * from instagram_order_items where order_id=$1',[d.id])).rows;
   const r=await request(d.id,{status:'مرتجع',customer_number:'0966666666'});const prior=await stock();await decision(r.id,true);
   assert.equal(await stock(),prior+1);assert.equal((await order(d.id)).status,'مرتجع');assert.equal((await order(d.id)).customer_number,'0966666666');
   assert.deepEqual((await db.query('select * from instagram_order_items where order_id=$1',[d.id])).rows,originalItems);
 });

 await test('admin shipping metadata and delivery-state edits preserve item snapshots and stock',async()=>{
   const s=await create('شحن',2);const prior=await stock();const items=(await db.query('select * from instagram_order_items where order_id=$1',[s.id])).rows;
   await edit(s.id,{customer_number:'0988888888',note:'تصحيح مباشر',shipping_delivery_status:'delivered'});
   const saved=await order(s.id);assert.equal(saved.customer_number,'0988888888');assert.equal(saved.shipping_delivery_status,'delivered');
   assert.equal(Number(saved.total_price),20000);assert.equal(await stock(),prior);
   assert.deepEqual((await db.query('select * from instagram_order_items where order_id=$1',[s.id])).rows,items);
 });
 await test('admin shipping item edits recalculate with the existing fee and adjust only the quantity delta',async()=>{
   const s=await create('شحن',2);const prior=await stock();await edit(s.id,{items:[{variant_id:ids.variant,quantity:3}],recalculate_total_price:true});
   assert.equal(await stock(),prior-1);const saved=await order(s.id);assert.equal(Number(saved.shipping_fee),10000);assert.equal(Number(saved.total_price),25000);
   await rpc('delete_instagram_order_atomic',[s.id,ids.admin]);assert.equal(await stock(),prior+2);
 });
 await test('changing delivery to shipping and back preserves discounted item price and reserves once',async()=>{
   const d=await create('توصيل',2);await db.query('update instagram_orders set driver_id=$1,driver_name=$2,total_price=8000,items_total=8000 where id=$3',[ids.driver,'سائق',d.id]);
   const prior=await stock();const items=(await db.query('select * from instagram_order_items where order_id=$1',[d.id])).rows;
   await edit(d.id,{order_type:'شحن'});let saved=await order(d.id);assert.equal(saved.order_type,'شحن');assert.equal(saved.driver_id,null);
   assert.equal(saved.shipping_delivery_status,'pending');assert.equal(Number(saved.total_price),18000);assert.equal(Number(saved.shipping_fee),10000);assert.equal(await stock(),prior);
   await edit(d.id,{order_type:'شحن'});assert.equal(Number((await order(d.id)).total_price),18000);assert.equal(await stock(),prior);
   await edit(d.id,{order_type:'توصيل'});saved=await order(d.id);assert.equal(saved.order_type,'توصيل');assert.equal(saved.status,'قيد المتابعة');assert.equal(Number(saved.total_price),8000);assert.equal(Number(saved.shipping_fee),0);assert.equal(await stock(),prior);
   assert.deepEqual((await db.query('select * from instagram_order_items where order_id=$1',[d.id])).rows,items);
 });
 await test('completed orders retain completion across type conversion and move inventory buckets',async()=>{
   const d=await create('توصيل',1);await rpc('change_instagram_order_status_atomic',[d.id,'تم',ids.admin,null]);const prior=await stock();
   const before=await row('select * from instagram_inventory_delivery_totals where product_id=$1 and size=$2',[ids.product,'L']);
   await edit(d.id,{order_type:'شحن'});let saved=await order(d.id);assert.equal(saved.shipping_delivery_status,'delivered');assert(saved.shipping_delivered_at);assert.equal(saved.status,'قيد المتابعة');
   const after=await row('select * from instagram_inventory_delivery_totals where product_id=$1 and size=$2',[ids.product,'L']);
   assert.equal(Number(after.sold_delivery),Number(before.sold_delivery)-1);assert.equal(Number(after.shipping_delivered),Number(before.shipping_delivered)+1);
   await edit(d.id,{order_type:'توصيل'});saved=await order(d.id);assert.equal(saved.status,'تم');assert.equal(saved.shipping_delivered_at,null);assert.equal(await stock(),prior);
 });
 await test('converting a released delivery order reactivates exactly its quantity',async()=>{
   const d=await create('توصيل',2);await rpc('change_instagram_order_status_atomic',[d.id,'إلغاء',ids.admin,null]);const prior=await stock();
   await edit(d.id,{order_type:'شحن'});assert.equal(await stock(),prior-2);assert.equal((await order(d.id)).status,'قيد المتابعة');
   await rpc('delete_instagram_order_atomic',[d.id,ids.admin]);assert.equal(await stock(),prior);
 });
 await test('type and item edits reserve the proposed variant directly without reserving a released old item',async()=>{
   const d=await create('توصيل',2);await rpc('change_instagram_order_status_atomic',[d.id,'إلغاء',ids.admin,null]);
   const prior=await stock();const old=await stock(ids.variant2);
   await edit(d.id,{order_type:'شحن',items:[{variant_id:ids.variant2,quantity:2}],recalculate_total_price:true});
   assert.equal(await stock(),prior);assert.equal(await stock(ids.variant2),old-2);assert.equal(Number((await order(d.id)).total_price),20000);
   await rpc('delete_instagram_order_atomic',[d.id,ids.admin]);assert.equal(await stock(ids.variant2),old);
 });
 await test('conversion shortage rolls back type, price, status and inventory',async()=>{
   const d=await create('توصيل',1);await rpc('change_instagram_order_status_atomic',[d.id,'مرتجع',ids.admin,null]);
   const before=await order(d.id);const prior=await stock();
   await assert.rejects(edit(d.id,{order_type:'شحن',items:[{variant_id:ids.variant2,quantity:999}],recalculate_total_price:true}),/غير متوفرة/);
   assert.deepEqual(await order(d.id),before);assert.equal(await stock(),prior);assert.equal(await stock(ids.variant2),8);
 });
 await test('shipping-to-delivery conversion and item edit apply together and later cancellation releases once',async()=>{
   const s=await create('شحن',2);await rpc('set_instagram_shipping_delivery_status_atomic',[[s.id],'delivered',ids.admin]);const prior=await stock();const second=await stock(ids.variant2);
   await edit(s.id,{order_type:'توصيل',items:[{variant_id:ids.variant2,quantity:3}],recalculate_total_price:true,driver_id:ids.driver});
   const saved=await order(s.id);assert.equal(saved.order_type,'توصيل');assert.equal(saved.status,'تم');assert.equal(saved.driver_id,ids.driver);
   assert.equal(Number(saved.shipping_fee),0);assert.equal(Number(saved.total_price),15000);assert.equal(await stock(),prior+2);assert.equal(await stock(ids.variant2),second-3);
   await edit(s.id,{status:'إلغاء'});assert.equal(await stock(ids.variant2),second);
   await rpc('delete_instagram_order_atomic',[s.id,ids.admin]);assert.equal(await stock(ids.variant2),second);
 });
 await test('viewer type conversion is deferred, can be rejected, and applies atomically on admin approval',async()=>{
   const s=await create('شحن',1);const before=await order(s.id);const prior=await stock();
   let proposal=await request(s.id,{order_type:'توصيل',status:'قيد المتابعة'});assert.deepEqual(await order(s.id),before);assert.equal(await stock(),prior);
   await decision(proposal.id,false);assert.deepEqual(await order(s.id),before);
   proposal=await request(s.id,{order_type:'توصيل',status:'تم'});await decision(proposal.id,true);
   const saved=await order(s.id);assert.equal(saved.order_type,'توصيل');assert.equal(saved.status,'تم');assert.equal(Number(saved.total_price),5000);assert.equal(await stock(),prior);
 });
 await test('a proposal cannot apply after the admin changes the order type',async()=>{
   const s=await create('شحن',1);const proposal=await request(s.id,{note:'مقترح قديم'});await edit(s.id,{order_type:'توصيل'});
   await assert.rejects(decision(proposal.id,true),/تغير نوع/);assert.notEqual((await order(s.id)).note,'مقترح قديم');
   assert.equal((await row('select status from instagram_order_edit_requests where id=$1',[proposal.id])).status,'معلق');await decision(proposal.id,false);
 });
 await test('type editor enforces admin permissions and rejects incompatible status/driver/currency',async()=>{
   const d=await create('توصيل',1);const prior=await order(d.id);
   await assert.rejects(edit(d.id,{order_type:'شحن'},ids.viewer),/غير مصرح/);
   for(const changes of [{order_type:'ثالث'},{order_type:'شحن',status:'تم'},{order_type:'شحن',shipping_delivery_status:'ثالث'},{order_type:'شحن',driver_id:ids.driver}]) await assert.rejects(edit(d.id,changes));
   assert.deepEqual(await order(d.id),prior);
   await db.query("update instagram_orders set currency='دولار' where id=$1",[d.id]);await assert.rejects(edit(d.id,{order_type:'شحن'}),/الليرة/);
   await db.exec('set role authenticated');try{await assert.rejects(edit(d.id,{note:'ممنوع'}),/permission denied/);}finally{await db.exec('reset role');}
 });

 await test('coexisting legacy overloads remain present while the new editor uses an unambiguous private function',async()=>{
   const signatures=await db.query("select oid::regprocedure::text as signature from pg_proc where pronamespace='public'::regnamespace and proname='update_instagram_order_atomic'");assert.equal(signatures.rows.length,2);
   const s=await create('شحن',1);const prior=await stock();await edit(s.id,{items:[{variant_id:ids.variant,quantity:2}],recalculate_total_price:true});
   assert.equal(await stock(),prior-1);assert.equal(Number((await order(s.id)).total_price),20000);
   await db.exec('set role service_role');try{await assert.rejects(db.query("select public.edit_instagram_order_items_core_atomic($1,$2)",[s.id,ids.admin]),/permission denied/);}finally{await db.exec('reset role');}
 });
 console.log(`SQL validation: ${passed} passed`);
 await db.close();
})().catch(async e=>{console.error({message:e.message,code:e.code,position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery,where:e.where}); if(e.position && e.query) console.error(e.query.slice(Math.max(0,Number(e.position)-180), Number(e.position)+180));try{await db.close();}catch{}process.exitCode=1;});
