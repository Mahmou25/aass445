# Website Checker — فاحص المواقع

موقع ويب احترافي لفحص المواقع عبر **متصفح حقيقي مدمج** (Playwright + Chromium) — يفتح كل موقع فعليًا ويعرض شاشته مباشرة داخل لوحة التحكم.

## التشغيل محليًا

```bash
npm install
npm start
```
ثم افتح http://localhost:3000

## النشر على Render (مجاني)

1. أنشئ حسابًا على [GitHub](https://github.com) ثم مستودعًا جديدًا (New repository)
2. ارفع الكود:

```bash
git init
git add .
git commit -m "Website checker"
git branch -M main
git remote add origin https://github.com/<اسم-المستخدم>/website-checker.git
git push -u origin main
```

3. أنشئ حسابًا على [Render](https://render.com) (سجّل بحساب GitHub)
4. **New → Web Service** → اختر المستودع
5. Render يكتشف `render.yaml` تلقائيًا — اضغط **Create Web Service**
6. بعد دقائق تحصل على رابط: `https://website-checker.onrender.com`

> ملاحظة: الخطة المجانية تتوقف عند عدم الاستخدام — أول فتح بعد التوقف يستغرق 30-60 ثانية للتشغيل.

## التقنيات

- Node.js + Express + WebSocket
- Playwright Core + Chromium (فحص حقيقي بدون iframe)
- بث مباشر للشاشة عبر Chrome DevTools Protocol
