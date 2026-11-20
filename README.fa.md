<div dir="rtl">

[English](./README.md) | **فارسی**

# ربات آپلودر تلگرام — فایل‌استور سرورلس روی تلگرام

[![Live Docs](https://img.shields.io/badge/Docs-Live_Guide-2AABEE?style=flat-square&logo=telegram&logoColor=white)](https://azipa.github.io/fa/projects/telegram-uploader-bot/)
![Telegram Serverless](https://img.shields.io/badge/Runtime-Telegram_Serverless-26A5E4?style=flat-square)
![@tgcloud/cli](https://img.shields.io/badge/@tgcloud%2Fcli-0.2.0-0969DA?style=flat-square)
![Node.js CI](https://img.shields.io/badge/Node.js_CI-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen?style=flat-square)](./LICENSE)

یک **ربات آپلودر تلگرام** و **ربات فایل‌استور تلگرام** آماده اجرا، ساخته‌شده به‌صورت بومی برای **تلگرام سرورلس** (`@tgcloud/cli`) با **دیتابیس داخلی SQLite** (۲۱ جدول) و **بدون نیاز به VPS یا سرور خارجی**. فایل‌های تکی یا دسته‌ای را آپلود کنید، برای **اشتراک‌گذاری فایل با لینک اختصاصی** لینک بسازید و از قابلیت‌هایی مانند **قفل جوین اجباری**، **محافظت از محتوا**، **حذف خودکار** زمان‌دار، **لینک یک‌بارمصرف**، چرخش خودکار لینک، رابط کاربری دوزبانه فارسی/انگلیسی و **دیپلوی با GitHub Actions** بهره ببرید.

> [!NOTE]
> - **ربات تمام‌بک‌اند (Backend-Only):** به‌طور بومی روی تلگرام سرورلس بدون مینی‌اپ یا وب‌سرور خارجی اجرا می‌شود؛ فایل‌ها روی سرورهای تلگرام باقی می‌مانند (`file_id` + پشتیبان‌گیری اختیاری در کانال ذخیره‌سازی خصوصی).
> - **نسخه کلادفلر ورکرز + D1 را ترجیح می‌دهید؟** مخزن همکار [AZiPA/telegram-uploader-bot-cloudflare](https://github.com/AZiPA/telegram-uploader-bot-cloudflare) ([مستندات آنلاین](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/)) را ببینید.

## راه‌اندازی سریع — دیپلوی در ۲ دقیقه (GitHub Actions)

1. **فعال‌سازی Serverless در `@BotFather`:** ربات خود را بسازید یا انتخاب کنید، گزینه **Serverless** را روشن کنید و **CLI Access Token** را از مسیر `Serverless → CLI Access → Access token` کپی کنید (`app<id>:<secret>` — نه توکن عادی HTTP Bot API).
2. **فورک کردن مخزن:** روی دکمه **Fork** در مخزن [`AZiPA/telegram-uploader-bot`](https://github.com/AZiPA/telegram-uploader-bot) کلیک کنید تا نسخه شخصی شما ساخته شود.
3. **افزودن سکرت‌های مخزن:** در مسیر **Settings → Secrets and variables → Actions** مقدار `TGCLOUD_TOKEN` (`app<id>:<secret>`، الزامی) و `OWNER_ID` (شناسه عددی تلگرام شما، اختیاری — توصیه‌شده برای ثبت خودکار مالک) را اضافه کنید.
4. **دیپلوی و ثبت مالکیت:** ورک‌فلوی دیپلوی GitHub Actions را اجرا کنید (یا یک کامیت پوش کنید). اگر `OWNER_ID` را تنظیم کرده‌اید، بلافاصله در پی‌وی ربات `/start` را بفرستید؛ در غیر این صورت برای خروج از وضعیت قفل‌شده اولیه (Zero-State)، فوراً دستور `/setbotowner` را ارسال کنید.

**نیاز به تنظیم کانال‌های اختیاری (ذخیره‌سازی، لاگ، جوین اجباری) یا دیپلوی محلی با `@tgcloud/cli` (Bash، CMD و PowerShell) دارید؟** [راهنمای راه‌اندازی و دیپلوی](https://azipa.github.io/fa/projects/telegram-uploader-bot/setup/) را ببینید.

## قابلیت‌های کلیدی

- **آپلود تکی و دسته‌ای با آینه‌سازی در کانال ذخیره‌سازی:** آپلود تک‌فایل یا دسته‌های تا ۲۵ فایل در ۸ نوع رسانه (`photo`، `document`، `video`، `audio`، `voice`، `video_note`، `animation`، `sticker`) با فهرست پویای رسانه‌های مجاز و بازیابی خودکار `copyMessages` از کانال ذخیره‌سازی خصوصی هنگام انقضای `file_id`.
- **تحویل صفحه‌بندی‌شده، محافظت و کنترل‌های موقت:** ارسال بسته‌ها در صفحات ۱۰تایی از طریق لینک اختصاصی تلگرام با پشتیبانی از `protect_content` (ارتقای خودکار لینک به UUID v4 با طول ۳۶ نویسه)، تایمر حذف خودکار، انقضای زمانی بسته و لینک یک‌بارمصرف.
- **چرخش خودکار لینک و همگام‌سازی زنده پست کانال:** چرخش دستی یا زمان‌بندی‌شده لینک اشتراک‌گذاری همراه با به‌روزرسانی آنی دکمه‌های شیشه‌ای در پست‌های منتشرشده کانال.
- **قفل جوین اجباری چندکاناله و رأی‌گیری کاربران:** الزام عضویت در حداکثر ۸ کانال با بررسی موازی و محدودیت فاصله کلیک، همراه با رأی‌گیری لایک/دیسلایک برای هر بسته و پشتیبانی خودتعمیر از ایموجی‌های پرمیوم سفارشی.
- **کنترل دسترسی ۵ سطحی (RBAC)، امنیت و ابزارهای مالک:** نقش‌های مالک، ابرمدیر، مدیر، کاربر ویژه (VIP با دانلود نامحدود) و کاربر عادی با گارد چت خصوصی Fail-Closed، محدودیت نرخ و بررسی مسدودیت/اخطار، انتقال دومرحله‌ای مالکیت، خروجی/درون‌ریزی JSON پیکربندی و کنسول اختصاصی SQLite.
- **۱۰۰٪ بومی روی تلگرام سرورلس + رابط کاربری دوزبانه:** بدون نیاز به `node_modules` در زمان اجرا، دارای دفتر کل ۲۱ جدولی SQLite برای آپلود و تحویل Idempotent (بدون تکرار) و بومی‌سازی کامل فارسی و انگلیسی با ۲۷۲ کلید متنی.

## مرکز مستندات کامل

| راهنما | پوشش موضوعات |
|---|---|
| [معرفی و ویژگی‌ها](https://azipa.github.io/fa/projects/telegram-uploader-bot/) | قابلیت‌های کلیدی، مدل اجرای سرورلس و مقایسه با نسخه کلادفلر |
| [راه‌اندازی و دیپلوی](https://azipa.github.io/fa/projects/telegram-uploader-bot/setup/) | تنظیم Serverless در BotFather، سکرت‌های CI، کانال‌ها و `@tgcloud/cli` (Bash، CMD و PowerShell) |
| [آپلود، تحویل و امنیت محتوا](https://azipa.github.io/fa/projects/telegram-uploader-bot/features-delivery/) | آپلود دسته‌ای، صفحه‌بندی ۱۰تایی، `protect_content`، لینک یک‌بارمصرف/TTL و چرخش لینک |
| [نقش‌ها، امنیت و مدیریت](https://azipa.github.io/fa/projects/telegram-uploader-bot/roles-security/) | دسترسی ۵ سطحی RBAC، ثبت مالکیت Zero-State، جوین اجباری، حالت تعمیرات و انتقال مالکیت |
| [دستورات و پیکربندی](https://azipa.github.io/fa/projects/telegram-uploader-bot/commands-config/) | مرجع کامل دستورات ربات، پنل‌های شیشه‌ای، `bot_config` و کنسول SQL مالک |
| [معماری و دیتابیس](https://azipa.github.io/fa/projects/telegram-uploader-bot/architecture/) | ۳ هندلر سرورلس، دفتر کل آپلود/تحویل Idempotent و ساختار ۲۱ جدول SQLite |

## مجوز

تحت مجوز [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE) منتشر شده است.

</div>
