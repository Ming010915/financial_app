# Personal Finance Tracker

A starter Flutter app for tracking personal expenses. It includes:

- Expense list with category, date, note, and amount
- Add-expense form
- Receipt import from camera, image upload, or PDF/image file upload
- Gemini spending summaries for weekly, monthly, and yearly history
- Month and all-time totals
- Category breakdown
- Local SQLite persistence with `sqflite`

## Setup

Install Flutter, then run:

```sh
flutter pub get
flutter create . --platforms=android,ios
flutter run
```

The `flutter create` command adds the Android and iOS platform folders around the existing Dart app.

## Gemini Features

Receipt import and AI spending insights use Gemini. Create a Gemini API key in
Google AI Studio, then pass it at build/run time:

```sh
flutter run --dart-define=GOOGLE_AI_API_KEY=your_key
```

The app uses `gemini-3-flash-preview` by default. To override it:

```sh
flutter run --dart-define=GOOGLE_AI_API_KEY=your_key --dart-define=GOOGLE_AI_MODEL=gemini-2.5-flash
```

This is fine for local development, but a shipped app should proxy Gemini requests through your backend so the API key is not exposed in the client.
# financial_app
