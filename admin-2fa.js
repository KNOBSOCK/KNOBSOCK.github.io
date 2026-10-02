(function () {
  var SUPABASE_URL = 'https://ypofuhazhxtzvtywguew.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_IJH4--fqVrrTrxG7Ou1JKw_G2WPOiIO';
  var client = null;

  function supa() {
    if (!client) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { flowType: 'implicit', storageKey: 'knobsock-admin-2fa', detectSessionInUrl: false }
      });
    }
    return client;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function twoFactorUntil(user) {
    if (!user) return Promise.resolve(0);
    return user.getIdTokenResult().then(function (result) {
      return Number(result.claims && result.claims.admin2faUntil) || 0;
    }).catch(function () { return 0; });
  }

  function getAccessToken() {
    return supa().auth.getSession().then(function (result) {
      if (result.error) throw result.error;
      var session = result.data && result.data.session;
      if (!session || !session.access_token) throw new Error('Your authenticator session expired. Sign in again.');
      return session.access_token;
    });
  }

  function mount(root, firebaseAuth, options) {
    var opts = options || {};
    var state = { email: '' };
    var inputStyle = opts.inputStyle || 'display:block;width:100%;box-sizing:border-box;margin:6px 0 12px;padding:10px;font-size:16px;';
    var buttonClass = opts.buttonClass || '';

    function screen(title, bodyHtml) {
      root.innerHTML =
        '<div class="admin-2fa" style="color:var(--text,#f2f2f2);">' +
          '<h2 style="margin:0 0 6px;font-size:17px;color:inherit;">' + esc(title) + '</h2>' +
          bodyHtml +
          '<div class="admin-2fa-msg" style="min-height:18px;margin-top:10px;font-size:13px;color:#ff6b6b;"></div>' +
        '</div>';
    }

    function message(text) {
      var el = root.querySelector('.admin-2fa-msg');
      if (el) el.textContent = text || '';
    }

    function busy(button, label) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = label;
      return function () {
        button.disabled = false;
        button.textContent = button.dataset.label;
      };
    }

    function onEnter(input, fn) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') fn(); });
    }

    function emailStep() {
      screen('Admin sign-in',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Step 1 of 2: we’ll email you a sign-in code.</p>' +
        '<label style="font-size:13px;">Email<input type="email" id="a2faEmail" autocomplete="email" inputmode="email" style="' + inputStyle + '"></label>' +
        '<button type="button" class="' + buttonClass + '" id="a2faSend">Email me a code</button>');
      var input = root.querySelector('#a2faEmail');
      var button = root.querySelector('#a2faSend');
      input.value = state.email;
      var go = function () {
        var email = input.value.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) { message('Enter a valid email address.'); return; }
        var done = busy(button, 'Sending…');
        supa().auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (res) {
          done();
          if (res.error) { message(res.error.message); return; }
          state.email = email;
          emailCodeStep();
        });
      };
      button.addEventListener('click', go);
      onEnter(input, go);
      input.focus();
    }

    function emailCodeStep() {
      screen('Admin sign-in',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Step 1 of 2: enter the code we emailed to ' + esc(state.email) + '.</p>' +
        '<label style="font-size:13px;">Email code<input type="text" id="a2faEmailCode" autocomplete="one-time-code" inputmode="numeric" maxlength="10" style="' + inputStyle + '"></label>' +
        '<button type="button" class="' + buttonClass + '" id="a2faVerifyEmail">Continue</button> ' +
        '<button type="button" class="' + buttonClass + '" id="a2faBack">Back</button>');
      var input = root.querySelector('#a2faEmailCode');
      var button = root.querySelector('#a2faVerifyEmail');
      root.querySelector('#a2faBack').addEventListener('click', emailStep);
      var go = function () {
        var code = input.value.replace(/\s/g, '');
        if (!/^\d{6,10}$/.test(code)) { message('Enter the code from the email.'); return; }
        var done = busy(button, 'Checking…');
        supa().auth.verifyOtp({ email: state.email, token: code, type: 'email' }).then(function (res) {
          done();
          if (res.error) { message('That code is wrong or has expired.'); return; }
          factorStep();
        });
      };
      button.addEventListener('click', go);
      onEnter(input, go);
      input.focus();
    }

    function factorStep() {
      supa().auth.mfa.listFactors().then(function (res) {
        if (res.error) { emailStep(); message(res.error.message); return; }
        var all = (res.data && res.data.all) || [];
        var verified = all.filter(function (f) { return f.factor_type === 'totp' && f.status === 'verified'; });
        if (verified.length) { totpStep(verified[0].id); return; }
        var stale = all.filter(function (f) { return f.factor_type === 'totp' && f.status !== 'verified'; });
        Promise.all(stale.map(function (f) { return supa().auth.mfa.unenroll({ factorId: f.id }); })).then(enrollStep);
      });
    }

    function enrollStep() {
      supa().auth.mfa.enroll({ factorType: 'totp', friendlyName: 'KNOBSOCK admin ' + Date.now() }).then(function (res) {
        if (res.error) { emailStep(); message(res.error.message); return; }
        var totp = res.data.totp || {};
        screen('Set up your authenticator',
          '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Step 2 of 2 (one-time setup): scan this with an authenticator app like Google Authenticator or 1Password, then enter the 6-digit code it shows.</p>' +
          '<img src="' + esc(totp.qr_code) + '" alt="Authenticator QR code" style="display:block;width:200px;height:200px;background:#fff;padding:8px;border-radius:8px;">' +
          '<p style="font-size:12px;opacity:.8;word-break:break-all;">Can’t scan? Enter this key instead: <b>' + esc(totp.secret) + '</b></p>' +
          '<label style="font-size:13px;">Authenticator code<input type="text" id="a2faTotp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="' + inputStyle + '"></label>' +
          '<button type="button" class="' + buttonClass + '" id="a2faVerifyTotp">Finish setup</button>');
        wireTotp(res.data.id);
      });
    }

    function totpStep(factorId) {
      screen('Admin sign-in',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Step 2 of 2: enter the 6-digit code from your authenticator app.</p>' +
        '<label style="font-size:13px;">Authenticator code<input type="text" id="a2faTotp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="' + inputStyle + '"></label>' +
        '<button type="button" class="' + buttonClass + '" id="a2faVerifyTotp">Sign in</button>');
      wireTotp(factorId);
    }

    function wireTotp(factorId) {
      var input = root.querySelector('#a2faTotp');
      var button = root.querySelector('#a2faVerifyTotp');
      var go = function () {
        var code = input.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) { message('Enter the 6-digit code.'); return; }
        var done = busy(button, 'Checking…');
        supa().auth.mfa.challengeAndVerify({ factorId: factorId, code: code }).then(function (res) {
          if (res.error) { done(); message('That code didn’t work. Try the newest one.'); return; }
          return supa().functions.invoke('chat-account', { body: { action: 'adminToken' } }).then(function (fn) {
            if (fn.error) {
              return (fn.error.context && fn.error.context.json ? fn.error.context.json() : Promise.resolve(null)).catch(function () { return null; }).then(function (details) {
                done();
                message((details && details.error) || 'Could not finish admin sign-in.');
              });
            }
            return firebaseAuth.signInWithCustomToken(fn.data.token).then(function () {
              done();
              if (opts.onSignedIn) opts.onSignedIn();
            });
          });
        }).catch(function (err) {
          done();
          message((err && err.message) || 'Could not finish admin sign-in.');
        });
      };
      button.addEventListener('click', go);
      onEnter(input, go);
      input.focus();
    }

    emailStep();
  }

  function signOut(firebaseAuth) {
    return Promise.all([
      firebaseAuth.signOut(),
      supa().auth.signOut().catch(function () {})
    ]);
  }

  window.KnobsockAdmin2FA = { mount: mount, twoFactorUntil: twoFactorUntil, getAccessToken: getAccessToken, signOut: signOut };
})();
