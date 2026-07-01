/**
 * Verify the new WAF detection fingerprints against the two real 405
 * responses observed in production:
 *
 *  Case A (Render log): short nginx default error page with fake version
 *    `<html><head><title>405 Not Allowed</title></head>
 *     <body><center><h1>405 Not Allowed</h1></center>
 *     <hr><center>nginx/1.31.2</center></body></html>`
 *
 *  Case B (Cherry Studio): full Aliyun WAF standard block page with
 *    errors.aliyun.com image URLs, data-spm, block_message, traceid
 *
 * Run: bun run scripts/verify-waf-detect.ts
 */
import { checkWafBlock } from "../src/proxy/handler.js";

// === Case A: nginx 伪装 405 (Render 日志观察到的形态) ===
const caseABody = `<html>
<head><title>405 Not Allowed</title></head>
<body>
<center><h1>405 Not Allowed</h1></center>
<hr><center>nginx/1.31.2</center>
</body>
</html>`;

const caseA = new Response(caseABody, {
  status: 405,
  headers: {
    "content-type": "text/html",
    "server": "nginx/1.31.2",
  },
});

// === Case B: 阿里云 WAF 标准拦截页 (Cherry Studio 观察到的形态) ===
const caseBBody = `<!doctypehtml><html lang="zh-cn"><meta charset="utf-8"><meta http-equiv="X-UA-Compatible"content="IE=edge,chrome=1"><meta name="data-spm"content="a3c0e"><title>405</title><style>a,body,div,h2,html,p{margin:0;padding:0}a{text-decoration:none;color:#3b6ea3}.container{width:1000px;margin:auto;color:#696969}.header{padding:110px 0}.header .message{height:36px;padding-left:120px;background:url(https://errors.aliyun.com/images/TB1TpamHpXXXXaJXXXXeB7nYVXX-104-162.png) no-repeat 0 -128px;line-height:36px}.main{padding:50px 0;background:#f4f5f7}#block_image{position:relative;left:120px}</style><body data-spm="7663354"><div data-spm="1998410538"><div class="header"><div class="container"><div class="message"><div id="block_message"></div><div><span id="block_url_tips"></span><strong id="url"></strong></div><div><span id="block_time_tips"></span><strong id="time"></strong></div><div><span id="block_traceid_tips"></span><strong id="traceid"></strong></div></div></div></div><div class="main"><div class="container"><img id="block_image"></div></div></div><script>function getRenderData(){var e=document.getElementById("renderData");return JSON.parse(e.innerHTML)}function convertTimestampToString(e){e=parseInt(e,10),e=new Date(e);return e.getFullYear()+"-"+("0"+(e.getMonth()+1)).slice(-2)+"-"+("0"+e.getDate()).slice(-2)+" "+("0"+e.getHours()).slice(-2)+":"+("0"+e.getMinutes()).slice(-2)+":"+("0"+e.getSeconds()).slice(-2)}var en_tips={block_message:"Sorry, your request has been blocked as it may cause potential threats to the server's security.",block_url_tips:"Current URL: ",block_time_tips:"Request Time: ",block_traceid_tips:"Your Request ID is: "},cn_tips={block_message:"很抱歉，由于您访问的URL有可能对网站造成安全安全威胁，您的访问被阻断。",block_url_tips:"当前网址: ",block_time_tips:"请求时间: ",block_traceid_tips:"您的请求ID是: "};window.onload=function(){var t=getRenderData(),n="cn";try{navigator.language.startsWith("zh")||(n="en")}catch(e){t.lang&&(n=t.lang)}if(t){var e,i=cn_tips,r=document.getElementById("block_image");for(e in"en"===n?(i=en_tips,r.src="https://g.alicdn.com/sd-base/static/1.0.5/image/405.png",r.id="en_block"):r.src="https://errors.aliyun.com/images/TB15QGaHpXXXXXOaXXXXia39XXX-660-117.png",i)document.getElementById(e).innerText=i[e];n=t.traceid,r=n.slice(8,21);document.getElementById("traceid").innerText=n,document.getElementById("url").innerText=location.href.split("?")[0],document.getElementById("time").innerText=convertTimestampToString(r)}}</script><textarea id="renderData" style="display:none">{"traceid":"0a0ccb6b17823817912067069e74b6","lang":"en"}</textarea>`;

const caseB = new Response(caseBBody, {
  status: 405,
  headers: {
    "content-type": "text/html; charset=utf-8",
    // Aliyun WAF 通常不带 server 头或带 Tengine,这里模拟无 server 头
  },
});

// === 负样本:正常的 API JSON 405 (不应该被识别为 WAF) ===
const negativeJson = new Response(
  JSON.stringify({ error: { type: "method_not_allowed", message: "POST only" } }),
  { status: 405, headers: { "content-type": "application/json" } },
);

// === 负样本:正常的 SSE 200 (不应该被识别为 WAF) ===
const negativeSse = new Response(
  "event: message_start\ndata: {}\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function run() {
  console.log("=== WAF Detection Verification ===\n");

  const a = await checkWafBlock(caseA);
  console.log("Case A (Render nginx 伪装 405):");
  console.log("  expected: wafBlocked=true");
  console.log("  actual:  ", a);
  console.log(a.wafBlocked ? "  ✓ PASS" : "  ✗ FAIL");
  console.log();

  const b = await checkWafBlock(caseB);
  console.log("Case B (Cherry Studio 阿里云标准 WAF 页):");
  console.log("  expected: wafBlocked=true");
  console.log("  actual:  ", b);
  console.log(b.wafBlocked ? "  ✓ PASS" : "  ✗ FAIL");
  console.log();

  const n1 = await checkWafBlock(negativeJson);
  console.log("Negative 1 (正常 JSON 405):");
  console.log("  expected: wafBlocked=false");
  console.log("  actual:  ", n1.wafBlocked ? "true (FAIL)" : "false");
  console.log(!n1.wafBlocked ? "  ✓ PASS" : "  ✗ FAIL");
  console.log();

  const n2 = await checkWafBlock(negativeSse);
  console.log("Negative 2 (正常 SSE 200):");
  console.log("  expected: wafBlocked=false");
  console.log("  actual:  ", n2.wafBlocked ? "true (FAIL)" : "false");
  console.log(!n2.wafBlocked ? "  ✓ PASS" : "  ✗ FAIL");
}

run().catch((e) => {
  console.error("Verification failed:", e);
  process.exit(1);
});
