const id=process.env.DISCORD_APPLICATION_ID,secret=process.env.DISCORD_CLIENT_SECRET;
if(!id||!secret)throw new Error('Set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET.');
const response=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'applications.commands.update',client_id:id,client_secret:secret}),signal:AbortSignal.timeout(10000)});
if(!response.ok)throw new Error(`Token exchange failed: HTTP ${response.status}`);
const {access_token}=await response.json();if(typeof access_token!=='string')throw new Error('Invalid token response');
// POST upserts this named command; it does not bulk-delete unrelated commands.
const result=await fetch(`https://discord.com/api/v10/applications/${id}/commands`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${access_token}`},body:JSON.stringify({name:'play',description:'Play a game against JEV',type:1,integration_types:[0],contexts:[0],options:[{type:1,name:'tic-tac-toe',description:'Play Tic-Tac-Toe against JEV'}]}),signal:AbortSignal.timeout(10000)});
if(!result.ok)throw new Error(`Command registration failed: HTTP ${result.status}`);
const command=await result.json();console.log(`Registered /play tic-tac-toe (command ${command.id}).`);
console.log(`Guild installation: https://discord.com/oauth2/authorize?client_id=${id}&scope=applications.commands&integration_type=0`);
