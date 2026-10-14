'use strict';
function scope(query={}){
 const result={};
 for(const key of ['state','city','property_id']){
  if(query[key]===undefined||query[key]==='')continue;
  if(typeof query[key]!=='string'||query[key].trim().length>120||/[\x00-\x1f]/.test(query[key]))throw Error('Invalid geography filter');
  result[key]=query[key].trim();
 }
 if(result.state)result.state=require('./nigeriaStates').canonical(result.state)||result.state;
 return result;
}
module.exports={scope};
