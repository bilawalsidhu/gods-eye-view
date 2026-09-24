python - <<'PY'
import pkgutil, sys
mods = [m.name for m in pkgutil.iter_modules()]
print('Installed packages count:', len(mods))
print('some:', mods[:20])
PY