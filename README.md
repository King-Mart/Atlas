# Atlas

3D Flight Trajectory Insight with AI-powered conflict resolution

## Project Structure

```
Atlas/
├── client/             # Frontend files
│   ├── datasets/       # Flight data JSON files
│   ├── index.html      # Main HTML page
│   ├── app.js          # Main application logic
│   ├── analytics.js    # Analytics tracking
│   └── client-ml.js    # Client-side ML
├── server/             # Backend files
│   ├── ai-service.js   # AI suggestions API
│   └── serve-client.js # Static file server
├── .env                # Environment variables
└── package.json        # Dependencies
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure your OpenAI API key in `.env`:
```
OPENAI_API_KEY=your_key_here
```

## Running the Application

### Option 1: Run AI Service Only
```bash
npm run start:server
```
Then open `client/index.html` directly in your browser or use a simple HTTP server.

### Option 2: Run Both Services
Terminal 1 - AI Service (port 3000):
```bash
npm run start:server
```

Terminal 2 - Client Server (port 8080):
```bash
npm run start:client
```

Then open http://localhost:8080

## Features

- Increase the time between takeoffs 
- Nearby aircraft should maintain different cruising altitudes
- Traffic density in latitude corridors 
- Prioritize the postponement of cargo flights over passenger flights

This is synthetic data for hackathon visualization only.
