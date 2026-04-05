import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { authenticate } from '@google-cloud/local-auth';
import { OAuth2Client } from 'google-auth-library';

config();

// Nodemailer uses Gmail SMTP + XOAUTH2, which requires this scope.
const SCOPES = ['https://mail.google.com/'];
const CREDENTIALS_PATH = process.env.GOOGLE_OAUTH_JSON_PATH || path.resolve(process.cwd(), 'google-client.json');
const TOKEN_PATH = process.env.GOOGLE_OAUTH_REFRESH_TOKEN_PATH || path.resolve(process.cwd(), 'google-token.json');

async function main() {
  // Check if credentials.json exists
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('The credentials file was not found. Please download the Google OAuth client secret file and place it in this directory.');
    process.exit(1);
  }

  // Interactive authorization
  const client: OAuth2Client = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: SCOPES,
  });

  // Save token
  const token = client.credentials;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log(`Token has been saved to ${TOKEN_PATH}. Please place this file along with credentials.json on the server.`);
}

main().catch((err) => {
  console.error('Authorization failed:', err);
  process.exit(1);
});
