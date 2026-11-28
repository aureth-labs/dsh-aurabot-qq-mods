const count=n=>Number.isSafeInteger(n)&&n>=0

/** Aurabot records disjoint fresh and cached inputs; no estimated fallback. */
export function nativeUsage(usage){
 const input=usage?.inputTokens,output=usage?.outputTokens,cached=usage?.cacheReadTokens??0,total=usage?.totalTokens,cacheWrite=usage?.cacheWriteTokens??0
 if(![input,output,cached,cacheWrite].every(count)||cacheWrite!==0)return null
 let fresh=input
 if(total!==undefined&&total!==null){
  if(!count(total))return null
  if(total===input+output+cached)fresh=input
  else if(total===input+output&&input>=cached)fresh=input-cached
  else return null
 }
 return {inputTokens:fresh,outputTokens:output,cacheReadTokens:cached}
}
