/**
 * 多用户模式的登录/注册页。
 *
 * 前端 App.tsx 没有任何登录态处理——它从来不需要：单人模式下 401 时服务端直接
 * 返回一个 PIN 页。多用户模式照这个做法，页面登录成功就 reload，App.tsx 一行不改。
 */
export function renderAuthPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PawPals 登录</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fdf3e8;font-family:system-ui}form{background:#fff;padding:2rem;border-radius:1.5rem;box-shadow:0 4px 24px #f4956a22;text-align:center;width:340px}h2{margin:0 0 .5rem;color:#3d2b1f;font-size:1.3rem}p{color:#8c6b52;font-size:.85rem;margin:0 0 1.2rem}input{width:100%;margin-top:.6rem;padding:.75rem 1rem;border:2px solid #f4956a44;border-radius:.75rem;font-size:1rem;outline:none;color:#3d2b1f}.err{color:#d4694a;font-size:.8rem;margin:.5rem 0 0;min-height:1em}button{margin-top:1rem;width:100%;padding:.75rem;background:#f4956a;color:#fff;border:none;border-radius:.75rem;font-size:1rem;cursor:pointer;font-weight:600}a{display:block;margin-top:.8rem;color:#8c6b52;font-size:.8rem;cursor:pointer}</style></head><body><form id="f"><h2>🐾 PawPals</h2><p id="tip">登录后继续</p><input id="email" type="email" placeholder="邮箱" autocomplete="email" autofocus><input id="pw" type="password" placeholder="密码（至少 8 位）" autocomplete="current-password"><div class="err" id="err"></div><button type="submit" id="go">登录</button><a id="sw">还没有账号？注册</a></form><script>
let mode='login';const $=id=>document.getElementById(id);
$('sw').onclick=()=>{mode=mode==='login'?'register':'login';$('go').textContent=mode==='login'?'登录':'注册';$('sw').textContent=mode==='login'?'还没有账号？注册':'已有账号？登录';$('tip').textContent=mode==='login'?'登录后继续':'注册一个新账号';$('err').textContent='';};
$('f').addEventListener('submit',async e=>{e.preventDefault();$('err').textContent='';const r=await fetch('/api/auth/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,password:$('pw').value})});const d=await r.json().catch(()=>({}));if(d.ok)location.reload();else $('err').textContent=d.error||'失败了，再试一次';});
</script></body></html>`;
}
