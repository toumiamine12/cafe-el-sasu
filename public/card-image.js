// "Karte aufs Handy": draws the member card as a phone-sized PNG (to keep in the photo gallery
// or set as lock screen) — the fallback for Apple/Google Wallet, which need paid developer accounts.
const TIER_COLORS = { Bronze: ['#5a3a1f', '#b47b47'], Silver: ['#55585e', '#b9bdc4'], Gold: ['#6f5212', '#d9b24c'] };

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

export async function saveCardImage(user) {
  const W = 1080, H = 1920;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = canvas.getContext('2d');
  await document.fonts?.ready;

  g.fillStyle = '#f9ead6';
  g.fillRect(0, 0, W, H);
  // the card
  const [from, to] = TIER_COLORS[user.tier.name];
  const grad = g.createLinearGradient(80, 300, W - 80, 960);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(80, 300, W - 160, 620, 48);
  g.fill();

  const [logo, qr] = await Promise.all([loadImage('photos/logo.png'), loadImage('/api/me/qr')]);
  g.drawImage(logo, 130, 350, 120, 120);
  g.fillStyle = '#fff';
  g.textAlign = 'right';
  g.font = 'italic 600 72px "Cormorant Garamond", Georgia, serif';
  g.fillText(user.tier.name, W - 130, 430);
  g.textAlign = 'left';
  g.font = '700 64px Karla, Arial, sans-serif';
  g.fillText(user.member_id.split('').join(' '), 130, 600);
  g.font = '400 44px Karla, Arial, sans-serif';
  g.fillText(user.name, 130, 670);
  g.font = '700 56px Karla, Arial, sans-serif';
  g.fillText(`${user.points} Punkte`, 130, 860);

  // big QR below the card for the counter scanner
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(W / 2 - 300, 1040, 600, 600, 32);
  g.fill();
  g.drawImage(qr, W / 2 - 260, 1080, 520, 520);
  g.fillStyle = '#3b2615';
  g.textAlign = 'center';
  g.font = '400 40px Karla, Arial, sans-serif';
  g.fillText('An der Theke zeigen – wir buchen Ihre Punkte darauf.', W / 2, 1720);
  g.font = 'italic 600 64px "Cormorant Garamond", Georgia, serif';
  g.fillText('Café el Sasu', W / 2, 200);

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `sasu-karte-${user.member_id}.png` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
