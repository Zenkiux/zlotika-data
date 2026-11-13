// minimal Nuxt devalue unflatten
export function unflatten(arr){const memo={};const H=(i)=>{if(i===-1)return undefined;if(i===-2)return null;if(i===-3)return NaN;if(i===-4)return Infinity;if(i===-5)return -Infinity;if(i===-6)return -0;
 if(i in memo)return memo[i];const v=arr[i];if(v===null||typeof v!=='object')return memo[i]=v;
 if(Array.isArray(v)){if(typeof v[0]==='string'){const t=v[0];if(['Reactive','ShallowReactive','Ref','ShallowRef','EmptyRef','EmptyShallowRef','NuxtError'].includes(t))return memo[i]=H(v[1]);if(t==='Date')return memo[i]=new Date(v[1]);if(t==='Set'){const s=new Set();memo[i]=s;for(let k=1;k<v.length;k++)s.add(H(v[k]));return s}if(t==='Map'){const m=new Map();memo[i]=m;for(let k=1;k<v.length;k+=2)m.set(H(v[k]),H(v[k+1]));return m}}
  const a=[];memo[i]=a;for(const x of v)a.push(H(x));return a}
 const o={};memo[i]=o;for(const k in v)o[k]=H(v[k]);return o};return H(0)}
