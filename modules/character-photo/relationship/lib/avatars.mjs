// Reuse local portraits with explicit persona bindings; never guess another role's image.
export function personaAvatars(api, people, current) {
 let photo
 try { photo=api.use?.('character-photo')?.snapshot?.() } catch { /* Optional module unavailable. */ }
 return people.map(person=>{
  if(person.id===current)return {...person,avatarUrl:'/aurabot/api/avatar',avatarSource:'native'}
  const profileId=photo?.personaBindings?.[person.id]
  const profile=profileId&&photo.profiles?.find(p=>p.id===profileId)
  const version=profile&&photo.versions?.find(v=>v.id===profile.versionId&&v.profileId===profile.id)
  const assetId=version?.references?.[0]
  const asset=assetId&&photo.assets?.find(a=>a.id===assetId&&!a.archived)
  return {...person,avatarUrl:asset?'/aurabot/api/ext/character-photo/image?id='+encodeURIComponent(asset.id):'',avatarSource:asset?'bound-photo':'missing'}
 })
}
