/** Production when NODE_ENV=production, or when PUBLIC_ORIGIN is an https origin on a non-loopback host (hosts that override NODE_ENV). */
export function isProduction(environment=process.env) {
  if(environment.NODE_ENV==='production')return true;
  try{const url=new URL(environment.PUBLIC_ORIGIN??'');return url.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname);}catch{return false;}
}
