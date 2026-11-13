// minimal turbo-stream (React Router) decoder for the first chunk
export function decodeTurbo(arr){const memo=new Map();const H=i=>{if(i<0)return i===-5?undefined:i===-7?null:i===-1?undefined:null;if(memo.has(i))return memo.get(i);const v=arr[i];
 if(Array.isArray(v)){if(typeof v[0]==='string'&&v[0].length===1&&/[DPYEM S]/.test(v[0])&&v.length<=3&&typeof v[1]!=='number'){return v}const a=[];memo.set(i,a);for(const x of v)a.push(H(x));return a}
 if(v&&typeof v==='object'){const o={};memo.set(i,o);for(const k in v)o[arr[+k.slice(1)]]=H(v[k]);return o}
 memo.set(i,v);return v};return H(0)}
