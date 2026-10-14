/* Shared canonical Nigerian state names. Keep portal copies byte-identical. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.FGStates=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const names=Object.freeze(['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','Federal Capital Territory','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara']);
 function canonical(value){if(typeof value!=='string')return null;const key=value.trim().replace(/\s+/g,' ').toLowerCase();if(['fct','abuja','fct abuja','abuja fct'].includes(key))return 'Federal Capital Territory';return names.find(name=>name.toLowerCase()===key)||null;}
 function populate(select,placeholder='Select state',selected=''){select.replaceChildren();const add=(text,value)=>{const option=document.createElement('option');option.textContent=text;option.value=value;select.appendChild(option);};add(placeholder,'');names.forEach(name=>add(name,name));select.value=canonical(selected)||'';}
 return Object.freeze({names,canonical,populate});
});
