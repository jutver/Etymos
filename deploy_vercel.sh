#!/bin/bash

# Exit on error
set -e

echo "Starting Vercel deployment..."

# Deploy to production (default target)
# Pass --prod to deploy to production, or remove it for a preview deployment
npx --cache .npm-cache vercel --prod --yes

echo "Deployment completed successfully!"
