import puppeteer from 'puppeteer';

async function test() {
  console.log('Starting puppeteer diagnostic...');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  const consoleLogs = [];
  page.on('console', msg => {
    const txt = msg.text();
    if (!txt.includes('Password field') && !txt.includes('[Detection]')) {
      consoleLogs.push({ type: msg.type(), text: txt });
    }
  });
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  await page.goto('http://localhost:4173', { waitUntil: 'networkidle2', timeout: 25000 });
  console.log('Page loaded.');

  const panelInfo = await page.evaluate(() => {
    const p = document.getElementById('ai-command-panel');
    if (!p) return { exists: false };
    const rect = p.getBoundingClientRect();
    const style = window.getComputedStyle(p);
    const input = p.querySelector('.ai-chat-input');
    const sendBtn = p.querySelector('.ai-send-btn');
    const msgs = p.querySelector('.ai-chat-messages');
    return {
      exists: true,
      classes: p.className,
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
      display: style.display,
      pointerEvents: style.pointerEvents,
      hasInput: Boolean(input),
      hasSendBtn: Boolean(sendBtn),
      msgCount: msgs ? msgs.children.length : 0,
      initialMsg: msgs ? msgs.textContent.slice(0, 100) : ''
    };
  });
  console.log('Panel info:', JSON.stringify(panelInfo, null, 2));

  console.log('Expanding panel...');
  await page.click('#ai-command-panel .panel-collapse-btn');
  await new Promise(r => setTimeout(r, 600));

  const afterExpand = await page.evaluate(() => {
    const p = document.getElementById('ai-command-panel');
    const input = p.querySelector('.ai-chat-input');
    const sendBtn = p.querySelector('.ai-send-btn');
    return {
      classes: p.className,
      inputVisible: Boolean(input && input.offsetParent !== null),
      sendBtnVisible: Boolean(sendBtn && sendBtn.offsetParent !== null),
      sendBtnRect: sendBtn ? sendBtn.getBoundingClientRect() : null,
      inputRect: input ? input.getBoundingClientRect() : null
    };
  });
  console.log('After expand:', JSON.stringify(afterExpand, null, 2));

  console.log('Typing message...');
  await page.type('#ai-command-panel .ai-chat-input', 'Hello JARVIS');
  
  console.log('Clicking send button...');
  await page.click('#ai-command-panel .ai-send-btn');

  const afterClick = await page.evaluate(() => {
    const p = document.getElementById('ai-command-panel');
    const msgs = p.querySelectorAll('.ai-msg');
    return {
      msgCount: msgs.length,
      msgs: Array.from(msgs).map(m => ({ cls: m.className, text: m.textContent.slice(0, 80) }))
    };
  });
  console.log('Immediately after click:', JSON.stringify(afterClick, null, 2));

  console.log('Waiting 12s for AI response...');
  await new Promise(r => setTimeout(r, 12000));

  const finalState = await page.evaluate(() => {
    const p = document.getElementById('ai-command-panel');
    const msgs = p.querySelectorAll('.ai-msg');
    return {
      msgCount: msgs.length,
      msgs: Array.from(msgs).map(m => ({ cls: m.className, text: m.textContent.slice(0, 150) }))
    };
  });
  console.log('Final state after 12s:', JSON.stringify(finalState, null, 2));

  if (consoleLogs.length > 0) {
    console.log('Relevant browser logs:', JSON.stringify(consoleLogs.slice(-15), null, 2));
  }

  await browser.close();
}

test().catch(console.error);
