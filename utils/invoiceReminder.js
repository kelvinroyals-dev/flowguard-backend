// Conservative billing notices: a due date alone is not proof of issuance/debt.
// Used by scheduling, manual reminders and the final delivery-time recheck.
async function eligible(db,invoice,now=Date.now()){
 if(!invoice||!['open','sent','partial','overdue'].includes(invoice.status)||!['pending','unpaid','partial','overdue'].includes(invoice.payment_status))return false;
 const issued=new Date(invoice.sent_at||'invalid').getTime();
 if(!Number.isFinite(issued)||issued>now||!(Number(invoice.sent_count)>0)||!invoice.user_id)return false;
 const balance=Number(invoice.balance_due),total=Number(invoice.total_amount),recorded=Number(invoice.amount_paid);
 if(invoice.amount_paid==null||![balance,total,recorded].every(Number.isFinite)||balance<=0||total<=0||recorded<0||!/^[A-Z]{3}$/.test(String(invoice.currency||'')))return false;
 const owner=await db.query("SELECT 1 FROM users WHERE id=$1 AND user_type='client' AND role='client' AND account_owner_id IS NULL AND service_provider_org_id IS NULL AND is_active=TRUE",[invoice.user_id]);
 if(!owner.rows.length)return false;
 const ledger=(await db.query(`SELECT COALESCE(SUM(amount),0) AS paid,
  COUNT(*) FILTER(WHERE currency IS DISTINCT FROM $2 OR amount IS NULL OR amount<0)::int AS invalid
  FROM payments WHERE invoice_id=$1 AND status='successful'`,[invoice.invoice_id,invoice.currency])).rows[0];
 const paid=Number(ledger?.paid),remaining=+(total-paid).toFixed(2);
 return Number.isFinite(paid)&&Number(ledger?.invalid)===0&&remaining>0&&Math.abs(recorded-paid)<0.005&&Math.abs(balance-remaining)<0.005;
}
module.exports={eligible};
