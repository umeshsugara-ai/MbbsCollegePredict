import { GoogleGenAI, Type } from "@google/genai";
import { StudentProfile, PredictionResponse } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function predictUniversities(profile: StudentProfile): Promise<PredictionResponse> {
  const prompt = `
    TODAY'S DATE: April 24, 2026.
    You are an expert global educational consultant for MBBS abroad. All data you provide must be relevant for the 2026 academic intake.
    
    A student with the following profile is seeking admission:
    - NEET Rank: ${profile.neetRank}
    - NEET Score: ${profile.neetScore}
    - Annual Budget (USD): ${profile.budgetInUSD || 'Any'}
    - Preferred Countries: ${profile.preferredCountries?.join(', ') || 'Any'}
    - Critical Preferences: ${profile.otherPreferences || 'None'}

    STRICT INSTRUCTION ON PREFERENCES:
    If the student mentions "Indian food", "Indian mess", or "Indian community", PRIORITIZE universities known for having on-campus Indian messes or a high density of Indian students (e.g., certain universities in Russia, Philippines, or Georgia).

    Predict the TOP 10 BEST Universities for this student for the 2026 intake. 
    ${profile.preferredCountries && profile.preferredCountries.length > 0 
      ? `STRICT REQUIREMENT: Only suggest universities located in one of these countries: ${profile.preferredCountries.join(', ')}.` 
      : 'Focus on popular destinations like Russia, Uzbekistan, Kazakhstan, Georgia, Philippines, Kyrgyzstan, etc.'}
    
    For each university, provide detailed information about:
    - Total Program Cost (approx. for 5/6 years)
    - Tuition Fee per Year
    - NMC / India Recognition Status (Verified for Indian students)
    - Clinical Exposure (Hospital quality)
    - Safety + Indian Student Support (Community presence)
    - ROI Score (1-10)
    - Final Category (Best For: Budget / Premium / Easy Admission)
    - Key medical specializations or research strengths (e.g., Cardiology, Surgery, etc.)
    - Continent (e.g., Europe, Asia, Americas, Africa)

    Ensure suggestions offer high-quality English-medium MBBS.
    Focus on universities where an Indian student with this rank/score has a high chance of admission.

    Provide the output in JSON format matching the specified schema.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["universities", "analysis"],
          properties: {
            universities: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "country", "continent", "annualTuitionFee", "totalProgramCost", "totalDurationYears", "mediumOfInstruction", "neetRequirement", "nmcRecognitionStatus", "globalRank", "rankingSource", "rankingYear", "clinicalExposure", "safetyAndSupport", "roiScore", "bestFor", "specializations", "reputationScore", "description"],
                properties: {
                  name: { type: Type.STRING },
                  country: { type: Type.STRING },
                  continent: { type: Type.STRING },
                  annualTuitionFee: { type: Type.STRING, description: "The annual tuition fee including currency symbol, e.g., '$5,000 USD' or '₹4,50,000 INR'" },
                  totalProgramCost: { type: Type.STRING, description: "Total cost for the entire program" },
                  totalDurationYears: { type: Type.STRING },
                  mediumOfInstruction: { type: Type.STRING },
                  neetRequirement: { type: Type.STRING },
                  nmcRecognitionStatus: { type: Type.STRING, description: "NMC / India Recognition Status" },
                  globalRank: { type: Type.STRING },
                  rankingSource: { type: Type.STRING },
                  rankingYear: { type: Type.STRING },
                  clinicalExposure: { type: Type.STRING },
                  safetyAndSupport: { type: Type.STRING },
                  roiScore: { type: Type.STRING },
                  bestFor: { type: Type.STRING },
                  specializations: { 
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  reputationScore: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            },
            analysis: { type: Type.STRING, description: "A brief professional analysis of why these colleges were chosen for this specific student." }
          }
        }
      }
    });

    const result = JSON.parse(response.text || '{}') as PredictionResponse;
    return result;
  } catch (error) {
    console.error("Prediction error:", error);
    throw new Error("Failed to generate college predictions. Please check your inputs and try again.");
  }
}
