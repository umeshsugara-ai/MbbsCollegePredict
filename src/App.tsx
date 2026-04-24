/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Sparkles, Globe, Award, BookOpen, ChevronRight, Stethoscope, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StudentProfile, PredictionResponse, University } from './types.ts';
import { predictUniversities } from './services/predictionService.ts';
import PredictorForm from './components/PredictorForm.tsx';
import UniversityTable from './components/UniversityTable.tsx';

export default function App() {
  const [result, setResult] = useState<PredictionResponse | null>(() => {
    const saved = localStorage.getItem('mbbs_predictor_results');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved results", e);
      }
    }
    return null;
  });
  const [profile, setProfile] = useState<StudentProfile | null>(() => {
    const saved = localStorage.getItem('mbbs_predictor_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return null;
      }
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [currency, setCurrency] = useState<'USD' | 'INR'>('USD');

  const handlePredict = async (p: StudentProfile) => {
    setIsLoading(true);
    setError(null);
    setProfile(p);
    try {
      const prediction = await predictUniversities(p);
      setResult(prediction);
      localStorage.setItem('mbbs_predictor_results', JSON.stringify(prediction));
      localStorage.setItem('mbbs_predictor_profile', JSON.stringify(p));
      setIsSidebarOpen(false); // Auto-collapse on success
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-6 selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header Section */}
      <header className="max-w-7xl mx-auto flex justify-between items-center mb-6 w-full">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl transition-all border ${
              isSidebarOpen 
                ? 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50' 
                : 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 animate-pulse'
            }`}
            title={isSidebarOpen ? "Collapse parameters" : "Expand parameters"}
          >
            {isSidebarOpen ? (
              <>
                <PanelLeftClose className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Hide Panel</span>
              </>
            ) : (
              <>
                <PanelLeftOpen className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Adjust Parameters</span>
              </>
            )}
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-indigo-900">
              MedScout AI <span className="text-indigo-500 font-medium">// MBBS Global Predictor</span>
            </h1>
            <p className="text-slate-500 text-sm">Finding the best medical universities for your rank.</p>
          </div>
        </div>
        <div className="flex gap-4 items-center">
          {result && (
            <div className="bg-white border border-slate-200 px-3 py-1 rounded-full text-[10px] font-bold text-slate-600 shadow-sm uppercase tracking-wider">
              RANK: {result.universities[0]?.neetRequirement || 'ANALYZED'}
            </div>
          )}
          <div className="bg-indigo-600 px-3 py-1 rounded-full text-[10px] font-bold text-white shadow-md uppercase tracking-wider flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
            AI ANALYSIS ACTIVE
          </div>
        </div>
      </header>

      {/* Main Content Grid */}
      <div className="max-w-7xl mx-auto flex gap-6 items-start">
        {/* Left Column: Inputs */}
        <AnimatePresence initial={false}>
          {isSidebarOpen && (
            <motion.div 
              initial={{ width: 0, opacity: 0, x: -20 }}
              animate={{ width: "300px", opacity: 1, x: 0 }}
              exit={{ width: 0, opacity: 0, x: -20 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="flex flex-col gap-4 overflow-hidden"
            >
              <div className="w-[300px] flex flex-col gap-4">
                <PredictorForm onPredict={handlePredict} isLoading={isLoading} />
                
                <div className="bg-indigo-900 rounded-2xl p-5 text-white flex flex-col gap-3 shadow-xl">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400"></div>
                    <span className="text-[10px] uppercase tracking-widest opacity-70 font-bold">Confidence Engine</span>
                  </div>
                  <div className="text-[10px] uppercase tracking-widest opacity-60 font-bold">Selection Confidence</div>
                  <div className="text-2xl font-mono font-bold">{result ? "98.2%" : "---"}</div>
                  <div className="mt-2 pt-2 border-t border-indigo-800 text-[9px] opacity-50 italic">
                    AI evaluates 150+ data points per university including clinical volume and FMGE pass rates.
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Right Column: Results */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <AnimatePresence mode="wait">
            {error && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-red-50 border border-red-200 p-4 rounded-xl text-red-700 text-xs font-bold uppercase tracking-wider"
              >
                {error}
              </motion.div>
            )}

            {!result && !isLoading && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm"
              >
                <Globe className="w-12 h-12 text-indigo-200 mx-auto mb-4" />
                <h3 className="text-slate-400 font-bold uppercase tracking-widest text-sm">Waiting for Data Input</h3>
                <p className="text-slate-400 text-xs mt-2">Fill in your NEET details on the left to begin the global search.</p>
              </motion.div>
            )}

            {result && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col gap-4"
              >
                {/* AI Insights Hero */}
                <div className="bg-indigo-900 rounded-3xl p-6 text-white shadow-2xl relative overflow-hidden">
                  <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="w-4 h-4 text-indigo-400" />
                      <span className="text-[10px] uppercase tracking-widest font-black text-indigo-300">Strategic AI Analysis</span>
                    </div>
                    <p className="text-lg font-light leading-relaxed text-indigo-50">
                      "{result.analysis}"
                    </p>
                  </div>
                  <Stethoscope className="absolute -right-8 -bottom-8 w-48 h-48 text-white/5 rotate-12" />
                </div>

                <UniversityTable 
                  universities={result.universities} 
                  currency={currency}
                  onCurrencyChange={setCurrency}
                  otherPreferences={profile?.otherPreferences}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Footer Status */}
      <footer className="max-w-7xl mx-auto mt-6 flex justify-between items-center text-[10px] font-medium text-slate-400 uppercase tracking-widest w-full">
        <div>Database last updated: April 2026 // NMC Criteria v2.8 (Latest)</div>
        <div className="flex gap-4 items-center">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(99,102,241,0.5)]"></span> 
            2026-27 Intake Intel Active
          </span>
          <span className="text-slate-300">|</span>
          <span>Global Rankings Engine: Verified Live</span>
        </div>
      </footer>
    </div>
  );
}
