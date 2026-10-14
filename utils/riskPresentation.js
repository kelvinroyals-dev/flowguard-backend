'use strict';
// Presentation bands only: does not change forecast scores or intervention logic.
function riskLevel(score,hasData=true) {
  if (!hasData || score==null || typeof score==='boolean' || String(score).trim()==='' || !Number.isFinite(Number(score)) || Number(score)<0 || Number(score)>100) return 'unknown';
  const value=Number(score);
  return value>=80?'critical':value>=60?'high':value>=45?'elevated':value>=25?'moderate':'low';
}
module.exports={riskLevel};
