#!/bin/bash
# ═══════════════════════════════════════════════════════
# ClaimOne Portal Bot — HP EliteDesk 800 G3 Setup Script
# Run: chmod +x setup-elitedesk.sh && sudo ./setup-elitedesk.sh
# ═══════════════════════════════════════════════════════

set -e
echo "═══ ClaimOne Portal Bot — EliteDesk Setup ═══"

# ─── 1. System Updates ───
echo "→ Updating system..."
apt-get update && apt-get upgrade -y

# ─── 2. Install Docker ───
echo "→ Installing Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  usermod -aG docker $SUDO_USER
  rm get-docker.sh
  echo "  Docker installed"
else
  echo "  Docker already installed"
fi

# ─── 3. Install Docker Compose ───
echo "→ Installing Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
  apt-get install -y docker-compose-plugin
  echo "  Docker Compose installed"
else
  echo "  Docker Compose already installed"
fi

# ─── 4. Install Node.js 20 (for local development/testing) ───
echo "→ Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "  Node.js $(node --version) installed"
else
  echo "  Node.js $(node --version) already installed"
fi

# ─── 5. Create bot directory ───
echo "→ Setting up bot directory..."
BOT_DIR="/opt/claimone-bot"
mkdir -p $BOT_DIR
cd $BOT_DIR

# ─── 6. Clone or pull repo ───
echo "→ Cloning ClaimOne repo (bot directory only, private repo: use a deploy key)..."
if [ ! -d ".git" ]; then
  git init
  git remote add origin https://github.com/drkeyurpatel-wq/claimone.git
  git config core.sparseCheckout true
  echo "bot/" >> .git/info/sparse-checkout
  git pull origin main
else
  git pull origin main
fi

cd bot

# ─── 7. Create .env from template ───
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  IMPORTANT: Edit /opt/claimone-bot/bot/.env"
  echo "  Fill in:"
  echo "    - SUPABASE_URL, SUPABASE_ANON_KEY, BOT_EMAIL, BOT_PASSWORD, CENTRE_ID"
  echo "    - HDFC_USERNAME / HDFC_PASSWORD"
  echo "    - MEDIASSIST_USERNAME / MEDIASSIST_PASSWORD"
  echo "    - ABHI_USERNAME / ABHI_PASSWORD"
  echo "═══════════════════════════════════════════"
  echo ""
fi

# ─── 8. Build Docker image ───
echo "→ Building Docker image..."
docker compose build

# ─── 9. Create systemd service for auto-start ───
echo "→ Creating systemd service..."
cat > /etc/systemd/system/claimone-bot.service << 'EOF'
[Unit]
Description=H1 Claims TPA Portal Bot
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/claimone-bot/bot
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claimone-bot

echo ""
echo "═══ Setup Complete ═══"
echo ""
echo "Next steps:"
echo "  1. Edit credentials:  nano /opt/claimone-bot/bot/.env"
echo "  2. Start the bot:     sudo systemctl start claimone-bot"
echo "  3. Check logs:        sudo docker compose logs -f"
echo "  4. Test single TPA:   cd /opt/claimone-bot/bot && docker compose run --rm claimone-bot node dist/scheduler.js --once --tpa=hdfc_ergo --action=check_status"
echo ""
echo "Bot will auto-start on boot via systemd."
echo "Status polling: every 30 min (Mon-Sat, 8 AM - 8 PM IST)"
echo "Pre-auth submit: every 15 min (Mon-Sat, 8 AM - 8 PM IST)"
echo "Letter download: 10 AM + 4 PM daily"
