const $ = (s) => document.querySelector(s);

const messagesEl = $('#messages');
const questionEl = $('#question');
const sendBtn = $('#sendBtn');

let lastQuestion = '';

function addMsg(text, me = false) {
  const div = document.createElement('div');
  div.className = 'msg' + (me ? ' me' : '');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addOfferButtons() {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.style.display = 'flex';
  wrap.style.gap = '8px';
  wrap.style.alignItems = 'center';
  wrap.textContent = 'Check the internet? ';
  const yes = document.createElement('button');
  yes.textContent = 'Yes';
  yes.className = 'btn';
  const no = document.createElement('button');
  no.textContent = 'No';
  no.className = 'btn';
  no.style.background = '#6b7280';

  yes.onclick = () => {
    wrap.remove();
    ask(lastQuestion, { withWeb: true });
  };
  no.onclick = () => wrap.remove();

  wrap.appendChild(yes);
  wrap.appendChild(no);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function promptFinancePassword() {
  const pw = window.prompt('Admin password required for financial questions:');
  if (!pw) return null;
  const res = await fetch('/api/finance-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  if (!res.ok) {
    addMsg('Admin permission failed (invalid password).', false);
    return null;
  }
  return true;
}

async function ask(message, opts = {}) {
  lastQuestion = message;
  addMsg(message, true);
  const thinking = addMsg('Thinking…');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...opts })
    });
    const data = await res.json();
    thinking.textContent = data.reply || data.error || 'No reply';

    if (data.requiresFinanceAuth) {
      const ok = await promptFinancePassword();
      if (ok) {
        // resend same question with financeOk flag
        const info = addMsg('Admin permission granted. Retrying…');
        const res2 = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, financeOk: true })
        });
        const d2 = await res2.json();
        info.textContent = d2.reply || d2.error || 'No reply';
      }
    } else if (data.offerWeb) {
      addOfferButtons();
    }
  } catch {
    thinking.textContent = 'Network error';
  }
}

sendBtn.addEventListener('click', () => {
  const q = (questionEl.value || '').trim();
  if (!q) return;
  questionEl.value = '';
  ask(q);
});
questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const q = (questionEl.value || '').trim();
    if (!q) return;
    questionEl.value = '';
    ask(q);
  }
});

// ---- digital clock ----
function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const t = document.getElementById('clockTime');
  const d = document.getElementById('clockDate');
  if (t) t.textContent = timeStr;
  if (d) d.textContent = dateStr;
}
updateClock();
setInterval(updateClock, 1000);
