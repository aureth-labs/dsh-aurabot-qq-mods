/** First instant belonging to a civil date in an IANA zone, including 23/25-hour
 * DST days. Never use the browser's or NAS process's local timezone implicitly. */
export function dateBoundary(date,timezone,{end=false}={}){
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('记录日期无效')
 const utc=Date.parse(date+'T00:00:00Z');if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,10)!==date)throw Error('记录日期无效')
 const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}),key=at=>{const p=Object.fromEntries(format.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day}
 const find=(day,center)=>{let low=center-172800000,high=center+172800000;while(low<high){const mid=Math.floor((low+high)/2);if(key(mid)<day)low=mid+1;else high=mid}return low}
 const first=find(date,utc);if(key(first)!==date)throw Error('该时区不存在这一天')
 return end?find(new Date(utc+86400000).toISOString().slice(0,10),utc+86400000)-1:first
}
