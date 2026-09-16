# Dingo Post Form Bot

A Telegram bot that repeats user messages and posts data to Google Sheets.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a Telegram bot:
   - Message @BotFather on Telegram
   - Use `/newbot` command
   - Follow the instructions to create your bot
   - Copy the bot token

3. Set up Google Sheets API:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable Google Sheets API
   - Create a Service Account
   - Generate a JSON key for the service account
   - Share your Google Sheet with the service account email

4. Add your credentials to the `.env` file:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   GOOGLE_SHEETS_CLIENT_EMAIL=your_service_account_email
   GOOGLE_SHEETS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nyour_private_key_here\n-----END PRIVATE KEY-----"
   GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_here
   ```

5. Run the bot:
   ```bash
   npm start
   ```

## Features

- Echoes back any message you send to it
- Automatically saves messages to Google Sheets with timestamp and username

## Development

For development with auto-restart:
```bash
npm run dev
```