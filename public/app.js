const messagesEl = document.getElementById('messages');
const questionEl = document.getElementById('question');
const sendBtn = document.getElementById('sendBtn');
const clockEl = document.getElementById('clock');

let lastQuestion = '';
let isSending = false;

function addMessage(text, me = false, isHTML = false) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (me ? ' me' : '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (isHTML) {
    bubble.innerHTML = text;
  } else {
    bubble.textContent = text;
  }
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setSending(state) {
  isSending = state;
  sendBtn.disabled = state;
  sendBtn.textContent = state ? '...' : 'Send';
}

async function sendQuestion(options = {}) {
  if (isSending) return;

  const { withWeb = false, financeOk = false, reuseLast = false } = options;

  let message;
  if (reuseLast && lastQuestion) {
    message = lastQuestion;
  } else {
    message = questionEl.value.trim();
    if (!message) return;
    lastQuestion = message;
    addMessage(message, true);
    questionEl.value = '';
  }

  setSending(true);
  addMessage('Thinking...');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, withWeb, financeOk })
    });

    if (res.status === 403) {
      window.location.href = '/login';
      return;
    }

    const data = await res.json();
    // replace last "Thinking..."
    messagesEl.lastChild.querySelector('.bubble').textContent =
      data.reply || data.error || 'No reply';

    // finance auth flow
    if (data.requiresFinanceAuth) {
      const pwd = window.prompt('This question is finance-related. Enter admin password:');
      if (!pwd) return;
      try {
        const r2 = await fetch('/api/finance-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const d2 = await r2.json();
        if (!r2.ok || !d2.ok) {
          addMessage('Admin permission denied or incorrect password.');
          return;
        }
        // resend with financeOk flag
        await sendQuestion({ withWeb: false, financeOk: true, reuseLast: true });
      } catch (e) {
        addMessage('Finance authorization failed.');
      }
      return;
    }

    // web offer flow
    if (data.offerWeb) {
      const row = document.createElement('div');
      row.className = 'msg-row';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      bubble.innerHTML = `
        ${data.reply}<br/>
        <div class="btn-inline">
          <button class="btn-small btn-yes" id="yesWeb">Yes, check internet</button>
          <button class="btn-small btn-no" id="noWeb">No</button>
        </div>
      `;

      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      document.getElementById('yesWeb').onclick = () =>
        sendQuestion({ withWeb: true, financeOk: false, reuseLast: true });
      document.getElementById('noWeb').onclick = () =>
        addMessage('Okay, I will stay within the project documents only.');
    }
  } catch (e) {
    console.error(e);
    messagesEl.lastChild.querySelector('.bubble').textContent = 'Chat failed.';
  } finally {
    setSending(false);
  }
}

// clock
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  clockEl.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(updateClock, 1000);
updateClock();

sendBtn.onclick = () => sendQuestion();
questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendQuestion();
  }
});

// greet
addMessage('Hello, this is the OHLA I-5 project assistant. How can I help you today?');
