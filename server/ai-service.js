// ai-service.js - Node.js server for AI suggestions
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const tf = require('@tensorflow/tfjs');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize OpenAI (optional)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Simple ML model for conflict prediction
class ConflictResolverML {
  constructor() {
    this.model = null;
    // Comment out model loading for now
    // this.loadModel();
  }
  
  async loadModel() {
    // Load a pre-trained model or create a simple one
    // this.model = await tf.loadLayersModel('file://./models/conflict-model.json');
    
    // Create a simple model instead
    this.model = this.createSimpleModel();
  }
  
  createSimpleModel() {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 16, activation: 'relu', inputShape: [7] }));
    model.add(tf.layers.dense({ units: 8, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 4, activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy' });
    return model;
  }
  
  async predictBestSolution(conflictData) {
    // Extract features for ML model
    const features = this.extractFeatures(conflictData);
    
    // Predict solution type (0: altitude, 1: speed, 2: route, 3: time)
    const prediction = this.model.predict(tf.tensor2d([features]));
    const solutionType = prediction.argMax(1).dataSync()[0];
    
    return this.generateSolution(solutionType, conflictData);
  }
  
  extractFeatures(conflict) {
    return [
      conflict.h_nm / 20,            // Normalized horizontal distance
      conflict.v_ft / 4000,          // Normalized vertical distance
      conflict.flightA.altitude / 50000,
      conflict.flightB.altitude / 50000,
      (conflict.time % 86400) / 86400, // Time of day
      conflict.flightA['aircraft speed'] / 600,
      conflict.flightB['aircraft speed'] / 600
    ];
  }
  
  generateSolution(type, conflict) {
    const solutions = [
      {
        type: 'altitude',
        target: conflict.flightA.altitude < conflict.flightB.altitude 
          ? conflict.flightA.ACID 
          : conflict.flightB.ACID,
        action: 'Adjust altitude',
        confidence: 0.85
      },
      {
        type: 'speed',
        target: conflict.flightA.ACID,
        action: 'Adjust speed',
        confidence: 0.70
      },
      {
        type: 'route',
        target: conflict.flightA.ACID,
        action: 'Minor route deviation',
        confidence: 0.75
      },
      {
        type: 'time',
        target: conflict.flightA.ACID,
        action: 'Delay departure',
        confidence: 0.90
      }
    ];
    
    return solutions[type];
  }
}

// Initialize ML resolver
const mlResolver = new ConflictResolverML();

// LLM-based suggestions using OpenAI
async function getLLMSuggestions(conflict) {
  try {
    const prompt = `
      You are an Air Traffic Control expert. Analyze this flight conflict and provide resolution options.
      
      Conflict Details:
      - Flight A: ${conflict.flightA.ACID} (${conflict.flightA['departure airport']} → ${conflict.flightA['arrival airport']})
      - Flight B: ${conflict.flightB.ACID} (${conflict.flightB['departure airport']} → ${conflict.flightB['arrival airport']})
      - Horizontal separation: ${conflict.h_nm.toFixed(2)} NM (minimum: 5 NM)
      - Vertical separation: ${Math.round(conflict.v_ft)} ft (minimum: 2000 ft)
      - Time: ${new Date(conflict.time * 1000).toISOString()}
      
      Provide 3 resolution options in JSON format with the following structure:
      [
        {
          "type": "altitude|speed|route|time",
          "target": "flight ACID",
          "action": "brief description",
          "description": "detailed explanation",
          "confidence": 0.0-1.0,
          "impact": "LOW|MEDIUM|HIGH"
        }
      ]
      
      Focus on safety, efficiency, and minimal disruption.
    `;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('OpenAI error:', error);
    return null;
  }
}

// API endpoint for AI suggestions
app.post('/api/ai-suggestions', async (req, res) => {
  try {
    const { conflict, allFlights } = req.body;
    
    // Get suggestions from multiple sources
    const [mlSuggestions, llmSuggestions] = await Promise.allSettled([
      mlResolver.predictBestSolution(conflict),
      getLLMSuggestions(conflict)
    ]);
    
    const suggestions = [];
    
    // Add ML suggestion
    if (mlSuggestions.status === 'fulfilled') {
      suggestions.push({
        ...mlSuggestions.value,
        source: 'ML Model'
      });
    }
    
    // Add LLM suggestions
    if (llmSuggestions.status === 'fulfilled' && llmSuggestions.value) {
      suggestions.push(...llmSuggestions.value.map(s => ({
        ...s,
        source: 'AI Expert'
      })));
    }
    
    // Add rule-based suggestions as fallback
    if (suggestions.length === 0) {
      suggestions.push(...generateFallbackSuggestions(conflict));
    }
    
    res.json(suggestions);
  } catch (error) {
    console.error('Error generating suggestions:', error);
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

function generateFallbackSuggestions(conflict) {
  // Simple rule-based suggestions
  return [
    {
      type: 'altitude',
      target: conflict.flightA.ACID,
      action: 'Climb 2000 ft',
      description: 'Increase vertical separation by climbing flight',
      confidence: 0.8,
      impact: 'LOW',
      source: 'Rule Engine'
    },
    {
      type: 'time',
      target: conflict.flightB.ACID,
      action: 'Delay 3 minutes',
      description: 'Create temporal separation with minor delay',
      confidence: 0.9,
      impact: 'MEDIUM',
      source: 'Rule Engine'
    }
  ];
}

// Export for Vercel serverless
module.exports = app;

// Local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`AI Service running on port ${PORT}`);
  });
}