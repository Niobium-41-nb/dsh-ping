#!/usr/bin/env node
/**
 * `dsh-ping` command line: raises one test notification so the delivery
 * channel can be verified without starting a session.
 */
import { runSmoke } from '../lib/smoke.js'

process.exitCode = runSmoke(process.argv.slice(2))
