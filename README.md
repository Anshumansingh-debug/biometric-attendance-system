# Biometric Attendance Management System

Full-stack attendance web app integrating dual **ZKTeco F09** biometric devices via push (ADMS) protocol, auto-capturing real-time punches for **120+ employees**.

## Tech Stack
`Node.js` `Express.js` `ZKTeco F09 (ADMS)` `Firebase` `Claude AI`

## Highlights
- Real-time punch capture from dual biometric devices over the ADMS push protocol
- Dual salary-cycle architecture (15-day & 30-day) supporting different payroll structures
- Auto-sync every 10 seconds between device and server
- Firestore-backed data recovery — zero data-loss punch capture, even on connectivity drops
- Designed system architecture and API layer with Claude AI assistance

## Why I Built This
The plant had no digital attendance system — punches were tracked manually. This app automates capture, storage, and payroll-ready reporting end-to-end, removing manual reconciliation entirely.
