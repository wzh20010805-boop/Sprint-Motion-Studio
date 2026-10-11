export async function productionRequest(path:string,body?:unknown) {
 const response=await fetch('/api/v1'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message??`HTTP ${response.status}`);return result;
}
