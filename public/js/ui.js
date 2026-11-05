// UI helpers: bottom sheet, modal confirm, prompt
export function openSheet(sheetEl, backdropEl) {
  backdropEl.hidden = false;
  sheetEl.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdropEl.classList.add('show');
    sheetEl.classList.add('show');
  }));
}
export function closeSheet(sheetEl, backdropEl) {
  backdropEl.classList.remove('show');
  sheetEl.classList.remove('show');
  setTimeout(() => { sheetEl.hidden = true; backdropEl.hidden = true; }, 260);
}
export function isSheetOpen(sheetEl) { return !sheetEl.hidden; }

export function confirmDialog({ title, message, okText = 'Xác nhận', danger = false }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `
      <div class="modal" style="padding:22px 20px;max-width:400px">
        <h3 style="margin:0 0 8px">${title}</h3>
        <p style="color:var(--text-dim);font-size:14px;margin:0 0 18px;line-height:1.5">${message}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn ghost cancel">Huỷ</button>
          <button class="btn ${danger ? 'danger' : 'primary'} ok">${okText}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    requestAnimationFrame(() => bd.querySelector('.modal').classList.add('show'));
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('.cancel').onclick = () => done(false);
    bd.querySelector('.ok').onclick = () => done(true);
    bd.addEventListener('click', (e) => { if (e.target === bd) done(false); });
  });
}

export function promptDialog({ title, placeholder = '', value = '', type = 'text' }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `
      <div class="modal" style="padding:22px 20px;max-width:400px">
        <h3 style="margin:0 0 12px">${title}</h3>
        <div class="field"><input type="${type}" placeholder="${placeholder}" value="${value ?? ''}"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn ghost cancel">Huỷ</button>
          <button class="btn primary ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector('input');
    requestAnimationFrame(() => { bd.querySelector('.modal').classList.add('show'); input.focus(); });
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('.cancel').onclick = () => done(null);
    bd.querySelector('.ok').onclick = () => done(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  });
}
