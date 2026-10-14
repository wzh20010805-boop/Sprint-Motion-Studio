/** 仅保留一行的有界字节；CR 在下一字节确认是否为 CRLF 后计数。 */
export async function* boundedByteLines(chunks:AsyncIterable<Uint8Array>,limit=1048576):AsyncGenerator<string|null> {
 const buffer=Buffer.allocUnsafe(limit);let size=0,cr=false,discard=false;
 const append=(byte:number)=>{if(size===limit){size=0;discard=true;return false;}buffer[size++]=byte;return true;};
 for await(const chunk of chunks)for(const byte of chunk){
  if(byte===10){if(!discard)yield buffer.subarray(0,size).toString('utf8');size=0;cr=false;discard=false;continue;}
  if(discard)continue;
  if(cr){cr=false;if(!append(13)){yield null;continue;}}
  if(byte===13){cr=true;continue;}
  if(!append(byte))yield null;
 }
 if(!discard){if(cr&&!append(13)){yield null;return;}if(size)yield buffer.subarray(0,size).toString('utf8');}
}
