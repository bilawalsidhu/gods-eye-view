/**
 * `v-class-toggle`: toggles each named class with `classList`, so classes other
 * code adds to the element (a voice highlight) survive a re-render. A `:class`
 * binding rewrites the whole `className` instead.
 */
const apply = (el, { value }) => {
  for (const [name, on] of Object.entries(value || {}))
    if (el.classList.contains(name) !== Boolean(on))
      el.classList.toggle(name, Boolean(on));
};
export const vClassToggle = { mounted: apply, updated: apply };
