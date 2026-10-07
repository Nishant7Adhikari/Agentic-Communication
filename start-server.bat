@echo off
title Agent Coordination Hub Server
cd /d "%~dp0"

if not exist .env (
    echo Creating .env file from .env.example...
    copy .env.example .env >nul
)

echo Starting Agent Coordination Hub Server...
npm run dev
pause
