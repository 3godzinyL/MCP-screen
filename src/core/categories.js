// System kolorów elementów — ten sam w nakładce, Studiu i obrazach dla AI.
// Kolor mówi, czym jest strefa; niebieski zostaje kolorem „przycisku”, jak w pierwszej wersji.
const CATEGORIES = {
  przycisk: { label: 'przycisk', color: '#2f6fed' },
  pole: { label: 'pole tekstowe', color: '#1f9d61' },
  wybor: { label: 'wybór / lista', color: '#8b5cf6' },
  menu: { label: 'menu / zakładka', color: '#e07b24' },
  link: { label: 'link / tekst', color: '#0ea5b7' },
  inne: { label: 'inne', color: '#d6409f' },
};

const ROLE_TO_CATEGORY = {
  Button: 'przycisk', SplitButton: 'przycisk',
  Edit: 'pole', Document: 'pole', Spinner: 'pole',
  ComboBox: 'wybor', ListItem: 'wybor', CheckBox: 'wybor', RadioButton: 'wybor', TreeItem: 'wybor', DataItem: 'wybor', Slider: 'wybor',
  TabItem: 'menu', MenuItem: 'menu', HeaderItem: 'menu',
  Hyperlink: 'link', Text: 'link',
  // nazwy z analizy pikseli / OCR
  'przycisk?': 'przycisk', 'pole?': 'pole', tekst: 'link', 'ikona/tekst?': 'inne',
};

function categoryOf(role, fallback = 'inne') {
  if (role && CATEGORIES[role]) return role;
  return ROLE_TO_CATEGORY[role] || fallback;
}

function colorOf(category) {
  return (CATEGORIES[category] || CATEGORIES.inne).color;
}

const ROLE_PREFIX = { przycisk: 'przycisk', pole: 'pole', wybor: 'wybor', menu: 'menu', link: 'link', inne: 'element' };

function slug(text, max = 34) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');
}

// Nazwa elementu z typu i napisu: „przycisk_wyslij_zgloszenie”, „pole_e_mail”.
function autoName(category, text, taken = new Set()) {
  const prefix = ROLE_PREFIX[category] || 'element';
  const s = slug(text);
  let base = s ? (s.startsWith(prefix) ? s : `${prefix}_${s}`) : prefix;
  base = base.slice(0, 48);
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}

module.exports = { CATEGORIES, categoryOf, colorOf, autoName, slug };
