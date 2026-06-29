/* Front-end logic for the authenticated app page.
 *
 * Wires the form to POST /api/send, renders the signed-in user's email in the
 * top bar, and shows a brief inline status. Plain ES2017+ — no build step. */

(function () {
  'use strict';

  var form = document.getElementById('send-form');
  var input = document.getElementById('message');
  var button = document.getElementById('send-btn');
  var status = document.getElementById('status');
  var who = document.getElementById('who');

  function setStatus(text, kind) {
    status.textContent = text || '';
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function fetchMe() {
    return fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.authenticated) {
          // Should not happen — server redirects unauthenticated GET / to /auth/google.
          window.location.href = '/auth/google';
          return null;
        }
        who.textContent = body.email;
        input.maxLength = body.maxMessageLength || 64;
        return body;
      });
  }

  function send(message) {
    button.disabled = true;
    setStatus('Sending…', '');
    return fetch('/api/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { ok: r.ok, status: r.status, body: body };
          });
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var message = input.value;
    if (!message || !message.trim()) {
      setStatus('Type a message first.', 'error');
      return;
    }
    send(message).then(function (res) {
      button.disabled = false;
      if (res.ok) {
        setStatus('Sent "' + res.body.message + '".', 'success');
        input.value = '';
        input.focus();
      } else {
        setStatus(res.body.error || 'Send failed.', 'error');
      }
    });
  });

  // Ctrl/Cmd+Enter is also handled by the form's default submit, but we
  // re-bind for the case where a user is mid-typing and the input loses focus.
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  fetchMe();
})();