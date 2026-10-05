import brand from '../brand.json';
import './brand.css';

export { brand };

export const brandLogo = brand.assets.logo ? new Image() : null;
if (brandLogo) brandLogo.src = `${import.meta.env.BASE_URL}brand/${brand.id}/${brand.assets.logo}`;

export const brandReady = Promise.allSettled([
  brandLogo?.decode(),
  document.fonts.load(`700 32px "${brand.fonts.display.family}"`),
  document.fonts.load(`400 16px "${brand.fonts.body.family}"`),
]);

// The suffix comes from <html data-app-title="...">, so a project can name its page without
// forking this module. Falls back to the framework label the starter template ships with.
export const appTitle = () => `${brand.name} / ${document.documentElement.dataset.appTitle || 'XR Framework'}`;

export function applyBrand() {
  document.title = appTitle();
  document.querySelector('#brand-name').textContent = brand.name;
  document.querySelector('#brand-tagline').textContent = brand.tagline;
  const logo = document.querySelector('#brand-logo');
  if (brandLogo) {
    logo.src = brandLogo.src;
    logo.alt = brand.name;
    logo.hidden = false;
    document.querySelector('.brand-wordmark').hidden = true;
  } else logo.remove();
  if (brand.assets.favicon) {
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.href = `${import.meta.env.BASE_URL}brand/${brand.id}/${brand.assets.favicon}`;
    document.head.append(favicon);
  }
  document.querySelector('meta[name="theme-color"]').content = brand.colors.background;
}
