(function () {
  var SUPABASE_URL = 'https://ypofuhazhxtzvtywguew.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_IJH4--fqVrrTrxG7Ou1JKw_G2WPOiIO';
  var client = null;

  function supa() {
    if (!client) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { flowType: 'implicit', storageKey: 'knobsock-admin-2fa', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true }
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
    var state = { email: '', viaEmailCode: false };
    var inputStyle = opts.inputStyle || 'display:block;width:100%;box-sizing:border-box;margin:6px 0 12px;padding:10px;font-size:16px;';
    var buttonClass = opts.buttonClass || '';
    var linkStyle = 'background:none;border:0;padding:0;margin-top:14px;font-size:13px;color:inherit;opacity:.75;text-decoration:underline;cursor:pointer;';

    function screen(title, bodyHtml) {
      root.innerHTML =
        '<div class="admin-2fa" style="color:var(--text,#f2f2f2);">' +
          '<h2 style="margin:0 0 6px;font-size:17px;color:inherit;">' + esc(title) + '</h2>' +
          '<form class="admin-2fa-form" autocomplete="on" novalidate>' + bodyHtml + '</form>' +
          '<div class="admin-2fa-msg" style="min-height:18px;margin-top:10px;font-size:13px;color:#ff6b6b;"></div>' +
        '</div>';
    }

    function onSubmit(fn) {
      root.querySelector('.admin-2fa-form').addEventListener('submit', function (e) {
        e.preventDefault();
        fn();
      });
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

    function passwordStep(note) {
      state.viaEmailCode = false;
      screen('Admin sign-in',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Step 1 of 2: email and password. This browser stays signed in after this, so next time it’s just the authenticator code.</p>' +
        '<label style="font-size:13px;">Email<input type="email" id="a2faEmail" name="email" autocomplete="username" inputmode="email" style="' + inputStyle + '"></label>' +
        '<label style="font-size:13px;">Password<input type="password" id="a2faPassword" name="password" autocomplete="current-password" style="' + inputStyle + '"></label>' +
        '<button type="submit" class="' + buttonClass + '" id="a2faSignIn">Sign in</button>' +
        '<div><button type="button" id="a2faUseCode" style="' + linkStyle + '">First time or forgot your password? Email me a code</button></div>');
      var emailInput = root.querySelector('#a2faEmail');
      var passwordInput = root.querySelector('#a2faPassword');
      var button = root.querySelector('#a2faSignIn');
      emailInput.value = state.email;
      root.querySelector('#a2faUseCode').addEventListener('click', function () {
        state.email = emailInput.value.trim().toLowerCase();
        emailStep();
      });
      onSubmit(function () {
        var email = emailInput.value.trim().toLowerCase();
        var password = passwordInput.value;
        if (!/^\S+@\S+\.\S+$/.test(email)) { message('Enter a valid email address.'); return; }
        if (!password) { message('Enter your password.'); return; }
        var done = busy(button, 'Signing in…');
        supa().auth.signInWithPassword({ email: email, password: password }).then(function (res) {
          done();
          if (res.error) { message('Wrong email or password. No password yet? Use the email code link below to set one.'); return; }
          state.email = email;
          factorStep();
        });
      });
      message(note);
      (state.email ? passwordInput : emailInput).focus();
    }

    function emailStep() {
      state.viaEmailCode = false;
      screen('Sign in with an email code',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">We’ll email you a sign-in code. After the authenticator step you can set a password so you don’t need this again.</p>' +
        '<label style="font-size:13px;">Email<input type="email" id="a2faEmail" name="email" autocomplete="username" inputmode="email" style="' + inputStyle + '"></label>' +
        '<button type="submit" class="' + buttonClass + '" id="a2faSend">Email me a code</button> ' +
        '<button type="button" class="' + buttonClass + '" id="a2faBack">Back</button>');
      var input = root.querySelector('#a2faEmail');
      var button = root.querySelector('#a2faSend');
      input.value = state.email;
      root.querySelector('#a2faBack').addEventListener('click', function () { passwordStep(); });
      onSubmit(function () {
        var email = input.value.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) { message('Enter a valid email address.'); return; }
        var done = busy(button, 'Sending…');
        supa().auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (res) {
          done();
          if (res.error) { message(res.error.message); return; }
          state.email = email;
          emailCodeStep();
        });
      });
      input.focus();
    }

    function emailCodeStep() {
      screen('Sign in with an email code',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Enter the code we emailed to ' + esc(state.email) + '.</p>' +
        '<label style="font-size:13px;">Email code<input type="text" id="a2faEmailCode" autocomplete="one-time-code" inputmode="numeric" maxlength="10" style="' + inputStyle + '"></label>' +
        '<button type="submit" class="' + buttonClass + '" id="a2faVerifyEmail">Continue</button> ' +
        '<button type="button" class="' + buttonClass + '" id="a2faBack">Back</button>');
      var input = root.querySelector('#a2faEmailCode');
      var button = root.querySelector('#a2faVerifyEmail');
      root.querySelector('#a2faBack').addEventListener('click', emailStep);
      onSubmit(function () {
        var code = input.value.replace(/\s/g, '');
        if (!/^\d{6,10}$/.test(code)) { message('Enter the code from the email.'); return; }
        var done = busy(button, 'Checking…');
        supa().auth.verifyOtp({ email: state.email, token: code, type: 'email' }).then(function (res) {
          done();
          if (res.error) { message('That code is wrong or has expired.'); return; }
          state.viaEmailCode = true;
          factorStep();
        });
      });
      input.focus();
    }

    function factorStep() {
      supa().auth.mfa.listFactors().then(function (res) {
        if (res.error) {
          supa().auth.signOut().catch(function () {}).then(function () { passwordStep('Your saved sign-in ran out. Sign in again.'); });
          return;
        }
        var all = (res.data && res.data.all) || [];
        var verified = all.filter(function (f) { return f.factor_type === 'totp' && f.status === 'verified'; });
        if (verified.length) { totpStep(verified[0].id); return; }
        var stale = all.filter(function (f) { return f.factor_type === 'totp' && f.status !== 'verified'; });
        Promise.all(stale.map(function (f) { return supa().auth.mfa.unenroll({ factorId: f.id }); })).then(enrollStep);
      });
    }

    function enrollStep() {
      supa().auth.mfa.enroll({ factorType: 'totp', friendlyName: 'KNOBSOCK admin ' + Date.now() }).then(function (res) {
        if (res.error) { passwordStep(res.error.message); return; }
        var totp = res.data.totp || {};
        screen('Set up your authenticator',
          '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">One-time setup: scan this with an authenticator app like Google Authenticator or 1Password, then enter the 6-digit code it shows.</p>' +
          '<img src="' + esc(totp.qr_code) + '" alt="Authenticator QR code" style="display:block;width:200px;height:200px;background:#fff;padding:8px;border-radius:8px;">' +
          '<p style="font-size:12px;opacity:.8;word-break:break-all;">Can’t scan? Enter this key instead: <b>' + esc(totp.secret) + '</b></p>' +
          '<label style="font-size:13px;">Authenticator code<input type="text" id="a2faTotp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="' + inputStyle + '"></label>' +
          '<button type="submit" class="' + buttonClass + '" id="a2faVerifyTotp">Finish setup</button>');
        wireTotp(res.data.id);
      });
    }

    function totpStep(factorId) {
      screen('Admin sign-in',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Enter the 6-digit code from your authenticator app' + (state.email ? ' for ' + esc(state.email) : '') + '. This unlocks admin for 12 hours.</p>' +
        '<label style="font-size:13px;">Authenticator code<input type="text" id="a2faTotp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="' + inputStyle + '"></label>' +
        '<button type="submit" class="' + buttonClass + '" id="a2faVerifyTotp">Unlock</button>' +
        '<div><button type="button" id="a2faForget" style="' + linkStyle + '">Use a different account</button></div>');
      root.querySelector('#a2faForget').addEventListener('click', function () {
        supa().auth.signOut().catch(function () {}).then(function () {
          state.email = '';
          passwordStep();
        });
      });
      wireTotp(factorId);
    }

    function wireTotp(factorId) {
      var input = root.querySelector('#a2faTotp');
      var button = root.querySelector('#a2faVerifyTotp');
      onSubmit(function () {
        var code = input.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) { message('Enter the 6-digit code.'); return; }
        var done = busy(button, 'Checking…');
        supa().auth.mfa.challengeAndVerify({ factorId: factorId, code: code }).then(function (res) {
          if (res.error) { done(); message('That code didn’t work. Try the newest one.'); return; }
          if (state.viaEmailCode) { done(); setPasswordStep(); return; }
          return finish(done);
        }).catch(function (err) {
          done();
          message((err && err.message) || 'Could not finish admin sign-in.');
        });
      });
      input.focus();
    }

    function setPasswordStep() {
      screen('Set your password',
        '<p style="margin:0 0 8px;font-size:13px;opacity:.8;">Pick a password and let your browser save it. From now on you sign in with email and password instead of an email code.</p>' +
        '<input type="email" name="email" autocomplete="username" value="' + esc(state.email) + '" readonly style="display:none;">' +
        '<label style="font-size:13px;">New password (8+ characters)<input type="password" id="a2faNewPassword" name="new-password" autocomplete="new-password" style="' + inputStyle + '"></label>' +
        '<button type="submit" class="' + buttonClass + '" id="a2faSavePassword">Save password</button> ' +
        '<button type="button" class="' + buttonClass + '" id="a2faSkipPassword">Skip</button>');
      var input = root.querySelector('#a2faNewPassword');
      var button = root.querySelector('#a2faSavePassword');
      root.querySelector('#a2faSkipPassword').addEventListener('click', function () {
        finish(busy(button, 'Signing in…'));
      });
      onSubmit(function () {
        var password = input.value;
        if (password.length < 8) { message('Use at least 8 characters.'); return; }
        var done = busy(button, 'Saving…');
        supa().auth.updateUser({ password: password }).then(function (res) {
          if (res.error) { done(); message(res.error.message); return; }
          state.viaEmailCode = false;
          finish(done);
        });
      });
      input.focus();
    }

    function finish(done) {
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
      }).catch(function (err) {
        done();
        message((err && err.message) || 'Could not finish admin sign-in.');
      });
    }

    supa().auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (!session) { passwordStep(); return; }
      state.email = (session.user && session.user.email) || '';
      factorStep();
    }).catch(function () { passwordStep(); });
  }

  function signOut(firebaseAuth) {
    return Promise.all([
      firebaseAuth.signOut(),
      supa().auth.signOut().catch(function () {})
    ]);
  }

  function lock(firebaseAuth) {
    return firebaseAuth.signOut();
  }

  window.KnobsockAdmin2FA = { mount: mount, twoFactorUntil: twoFactorUntil, getAccessToken: getAccessToken, signOut: signOut, lock: lock };
})();
