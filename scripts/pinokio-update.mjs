#!/usr/bin/env node
import { installPinokioDependencies, runChecked } from './pinokio-install.mjs';

runChecked('git', ['pull', '--ff-only']);
installPinokioDependencies();
