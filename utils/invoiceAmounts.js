// Financial input validation only. No tax/contract policy is inferred here.
const number=v=>v==null || v==='' || typeof v==='boolean' || !Number.isFinite(Number(v)) ? null : Number(v);
const round=v=>Math.round((v+Number.EPSILON)*100)/100;
function invoiceAmounts(body,previous={}) {
  const items=body.line_items ?? previous.line_items;
  if (!Array.isArray(items) || !items.length) throw new Error('At least one recorded line item is required');
  for(const item of items) {
    if (!item || typeof item.description!=='string' || !item.description.trim() || number(item.amount)==null || number(item.amount)<0) throw new Error('Each line needs a description and a nonnegative finite amount');
    for(const key of ['qty','unit_price']) if(item[key]!=null && (number(item[key])==null || number(item[key])<0)) throw new Error('Line quantities and prices must be nonnegative finite numbers');
    if (item.qty!=null && item.unit_price!=null && Math.abs(round(Number(item.qty)*Number(item.unit_price))-Number(item.amount))>0.01) throw new Error('Line amount must match quantity multiplied by price');
  }
  const rate=number(body.vat_rate ?? previous.vat_rate ?? 7.5);
  if (rate==null || rate<0 || rate>100) throw new Error('Recorded tax rate must be between 0 and 100');
  const subtotal=round(items.reduce((sum,item)=>sum+Number(item.amount),0));
  const vat=round(subtotal*rate/100),total=round(subtotal+vat);
  if (body.total_amount!=null && (number(body.total_amount)==null || Math.abs(Number(body.total_amount)-total)>0.01)) throw new Error('Invoice total must match the recorded lines and tax');
  for(const key of ['issue_date','due_date']) {
    if(body[key]!=null && (!/^\d{4}-\d{2}-\d{2}$/.test(body[key]) || !Number.isFinite(new Date(body[key]).getTime()) || new Date(body[key]).toISOString().slice(0,10)!==body[key])) throw new Error('Valid invoice dates are required');
  }
  return {items,subtotal,vatRate:rate,vatAmount:vat,total};
}
module.exports={invoiceAmounts};
