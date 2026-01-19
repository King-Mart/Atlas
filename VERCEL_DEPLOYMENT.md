# Deploying to Vercel

## Prerequisites
- Vercel account (sign up at https://vercel.com)
- Git repository (GitHub, GitLab, or Bitbucket)
- Vercel CLI (optional): `npm install -g vercel`

## Step 1: Push to GitHub

1. Initialize git (if not already done):
```bash
git init
git add .
git commit -m "Initial commit"
```

2. Create a new repository on GitHub and push:
```bash
git remote add origin https://github.com/YOUR_USERNAME/Atlas.git
git branch -M main
git push -u origin main
```

## Step 2: Deploy to Vercel

### Option A: Using Vercel Dashboard (Easiest)
1. Go to https://vercel.com/new
2. Select your GitHub repository
3. In "Environment Variables", add:
   - `OPENAI_API_KEY`: Your OpenAI API key
4. Click "Deploy"

### Option B: Using Vercel CLI
1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel
```

3. Follow the prompts and add environment variables when asked

## Configuration

The `vercel.json` file already configures:
- **outputDirectory**: `client` (serves your frontend)
- **functions**: `server/ai-service.js` as a serverless function
- **rewrites**: Routes `/api/*` to the serverless function

## Environment Variables

Set these in Vercel Project Settings > Environment Variables:
- `OPENAI_API_KEY`: Your OpenAI API key

## API Endpoints

After deployment, your API will be available at:
```
https://your-project.vercel.app/api/ai-suggestions
```

Update the API URL in your client code if needed.

## Troubleshooting

If you encounter issues:
1. Check Vercel build logs: Dashboard > Project > Deployments
2. Ensure all dependencies are in `package.json`
3. Verify environment variables are set
4. Check that all file paths use forward slashes (/)
