/* Deck engine: scale-to-fit, keyboard/arrow navigation, sidebar, hash deep-link.
   Slides are static <section class="slide" data-nav data-group> in index.html. */
(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const $ = s => document.querySelector(s);
  const thread = $('#thread'), counter = $('#counter');
  const prev = $('.nav-arrow.prev'), next = $('.nav-arrow.next');
  let i = 0;

  function fit() {
    const left = document.body.classList.contains('sb-open') ? 300 : 0;
    const w = window.innerWidth - left, h = window.innerHeight;
    const s = Math.min((w - 120) / 1280, (h - 70) / 720);
    slides.forEach(el => { el.style.transform = `scale(${Math.max(s, .2)})`; });
  }

  function show(n, dir) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    document.body.classList.toggle('back', dir === 'back');
    slides.forEach((el, k) => el.classList.toggle('on', k === i));
    thread.style.width = `${((i + 1) / slides.length) * 100}%`;
    counter.innerHTML = `<b>${i + 1}</b> / ${slides.length}`;
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    document.querySelectorAll('.sb-item').forEach((el, k) => el.classList.toggle('on', k === i));
    history.replaceState(null, '', `#s${i + 1}`);
    document.title = `${i + 1} · ${slides[i].dataset.nav} — AppHub`;
  }
  const go = d => show(i + d, d < 0 ? 'back' : 'fwd');

  function buildSidebar() {
    const body = $('.sb-body');
    let group = null;
    slides.forEach((el, k) => {
      if (el.dataset.group !== group) {
        group = el.dataset.group;
        const g = document.createElement('div');
        g.className = 'sb-group'; g.textContent = group; body.appendChild(g);
      }
      const it = document.createElement('div');
      it.className = 'sb-item';
      it.innerHTML = `<i>${String(k + 1).padStart(2, '0')}</i><span>${el.dataset.nav}</span>`;
      it.onclick = () => show(k, k < i ? 'back' : 'fwd');
      body.appendChild(it);
    });
  }
  const toggleSb = force => {
    document.body.classList.toggle('sb-open', force);
    setTimeout(fit, 320); fit();
  };

  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  $('#menu-toggle').onclick = () => toggleSb();
  $('.sb-close').onclick = () => toggleSb(false);

  /* Lightbox — captures inside a .zoomable container open full size on click.
     While open, ←/→ step through the captures on the same slide instead of
     changing slides, and the X button or Esc closes it. */
  const lb = $('#lightbox'), lbImg = lb.querySelector('img'), lbCap = lb.querySelector('.t');
  let lbList = [], lbIdx = 0;
  const lbShow = n => {
    lbIdx = (n + lbList.length) % lbList.length;
    const shot = lbList[lbIdx];
    lbImg.src = shot.querySelector('img').src;
    const cap = shot.parentElement.querySelector('.shot-cap');
    let label = '';
    if (cap) {
      const c = cap.cloneNode(true);
      c.querySelectorAll('.num').forEach(n => n.remove());
      label = c.textContent.replace(/\s+/g, ' ').trim();
    }
    lbCap.textContent = `${lbIdx + 1} / ${lbList.length}${label ? ' · ' + label : ''}`;
  };
  const lbClose = () => { lb.hidden = true; };
  document.addEventListener('click', e => {
    const shot = e.target.closest('.zoomable .shot');
    if (!shot) return;
    lbList = [...shot.closest('.zoomable').querySelectorAll('.shot')];
    lbShow(lbList.indexOf(shot));
    lb.hidden = false;
  });
  lb.querySelector('.lb-close').addEventListener('click', lbClose);

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (!lb.hidden) {
      e.preventDefault();
      if (k === 'ArrowRight' || k === ' ') lbShow(lbIdx + 1);
      else if (k === 'ArrowLeft') lbShow(lbIdx - 1);
      else if (k === 'Escape') lbClose();
      return;
    }
    if (['ArrowRight', 'PageDown', ' '].includes(k)) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp'].includes(k)) { e.preventDefault(); go(-1); }
    else if (k === 'Home') show(0, 'back');
    else if (k === 'End') show(slides.length - 1, 'fwd');
    else if (k === 'm' || k === 'M') toggleSb();
    else if (k === 'f' || k === 'F') {
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    } else if (k === 'Escape') toggleSb(false);
  });
  window.addEventListener('resize', fit);

  buildSidebar();
  fit();
  const m = location.hash.match(/^#s(\d+)$/);
  show(m ? parseInt(m[1], 10) - 1 : 0);
})();
