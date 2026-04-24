import React, { useState, useMemo, useRef, useEffect } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { StudentProfile } from '../types';
import { AnimatePresence, motion } from 'motion/react';

interface Props {
  onPredict: (profile: StudentProfile) => void;
  isLoading: boolean;
}

const ALL_COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
  "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi",
  "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic",
  "Denmark", "Djibouti", "Dominica", "Dominican Republic",
  "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia",
  "Fiji", "Finland", "France",
  "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana",
  "Haiti", "Honduras", "Hungary",
  "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy",
  "Jamaica", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan",
  "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
  "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway",
  "Oman",
  "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
  "Qatar",
  "Romania", "Russia", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
  "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan",
  "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
  "Yemen",
  "Zambia", "Zimbabwe"
];

export default function PredictorForm({ onPredict, isLoading }: Props) {
  const [formData, setFormData] = useState<StudentProfile>(() => {
    const saved = localStorage.getItem('mbbs_predictor_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved profile", e);
      }
    }
    return {
      neetRank: 0,
      neetScore: 0,
      budgetInUSD: '',
      preferredCountries: [],
      otherPreferences: ''
    };
  });
  const [error, setError] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.neetRank <= 0 && formData.neetScore <= 0) {
      setError('Please provide either NEET Rank or Score.');
      return;
    }
    setError('');
    onPredict(formData);
  };

  const handleSave = () => {
    localStorage.setItem('mbbs_predictor_profile', JSON.stringify(formData));
    alert('Preferences saved successfully!');
  };

  const toggleCountry = (country: string) => {
    setFormData(prev => ({
      ...prev,
      preferredCountries: prev.preferredCountries?.includes(country)
        ? prev.preferredCountries.filter(c => c !== country)
        : [...(prev.preferredCountries || []), country]
    }));
  };

  const filteredCountries = useMemo(() => {
    return ALL_COUNTRIES.filter(c => 
      c.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery]);

  return (
    <div id="predictor-form" className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <h2 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-4">Prediction Parameters</h2>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">AIR SCORE / RANK*</label>
          <div className="grid grid-cols-2 gap-2">
            <input 
              type="number" 
              min="1"
              max="720"
              placeholder="Score"
              className="w-full bg-slate-100 border-none rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              value={formData.neetScore || ''}
              onChange={(e) => setFormData({...formData, neetScore: parseInt(e.target.value) || 0})}
            />
            <input 
              type="number" 
              min="1"
              placeholder="Rank"
              className="w-full bg-slate-100 border-none rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              value={formData.neetRank || ''}
              onChange={(e) => setFormData({...formData, neetRank: parseInt(e.target.value) || 0})}
            />
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">Max Budget (Total)</label>
          <select 
            className="w-full bg-slate-100 border-none rounded-lg px-3 py-2 text-sm text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none"
            value={formData.budgetInUSD}
            onChange={(e) => setFormData({...formData, budgetInUSD: e.target.value})}
          >
            <option value="">Select Range</option>
            <option value="15000">₹15L - ₹25L</option>
            <option value="30000">₹25L - ₹40L</option>
            <option value="50000">₹40L+</option>
          </select>
        </div>

        <div className="relative" ref={dropdownRef}>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-2">Preferred Countries</label>
          <div 
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="w-full min-h-[42px] bg-slate-100 rounded-lg px-3 py-2 text-sm cursor-pointer border-none flex flex-wrap gap-2 items-center justify-between group transition-colors hover:bg-slate-200/50"
          >
            <div className="flex flex-wrap gap-1">
              {formData.preferredCountries && formData.preferredCountries.length > 0 ? (
                formData.preferredCountries.map(c => (
                  <span key={c} className="bg-indigo-600 text-white text-[9px] font-bold px-2 py-0.5 rounded flex items-center gap-1">
                    {c}
                    <X 
                      className="w-2.5 h-2.5 cursor-pointer hover:text-indigo-200" 
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCountry(c);
                      }}
                    />
                  </span>
                ))
              ) : (
                <span className="text-slate-400 italic">Global search...</span>
              )}
            </div>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
          </div>

          <AnimatePresence>
            {isDropdownOpen && (
              <motion.div 
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.15 }}
                className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden"
              >
                <div className="p-2 border-b border-slate-100 bg-slate-50">
                  <div className="relative">
                    <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input 
                      autoFocus
                      type="text"
                      placeholder="Find country..."
                      className="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto custom-scrollbar">
                  {filteredCountries.length > 0 ? (
                    filteredCountries.map(c => (
                      <div 
                        key={c}
                        onClick={() => toggleCountry(c)}
                        className={`px-3 py-2 text-[11px] cursor-pointer flex items-center justify-between hover:bg-slate-50 transition-colors ${
                          formData.preferredCountries?.includes(c) ? 'text-indigo-600 bg-indigo-50/50 font-bold' : 'text-slate-600'
                        }`}
                      >
                        {c}
                        {formData.preferredCountries?.includes(c) && (
                          <div className="w-2 h-2 rounded-full bg-indigo-600" />
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-6 text-xs text-slate-400 text-center italic">No results found</div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">Other Preferences</label>
          <textarea 
            placeholder="e.g. Need Indian food availability, specific city etc."
            rows={2}
            className="w-full bg-slate-100 border-none rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
            value={formData.otherPreferences}
            onChange={(e) => setFormData({...formData, otherPreferences: e.target.value})}
          />
        </div>

        {error && (
          <div className="text-[10px] font-bold text-red-500 uppercase tracking-tighter bg-red-50 p-2 rounded border border-red-100">
            {error}
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <button 
            type="submit" 
            disabled={isLoading}
            className="flex-[2] bg-indigo-900 text-white font-bold py-4 rounded-xl text-xs uppercase tracking-widest hover:bg-indigo-800 transition-all shadow-lg shadow-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            {isLoading ? (
              <div className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>Analyzing...</span>
              </div>
            ) : "Find My College"}
          </button>
          <button 
            type="button"
            onClick={handleSave}
            className="flex-1 bg-white border border-slate-200 text-slate-600 font-bold py-4 rounded-xl text-[9px] uppercase tracking-wider hover:bg-slate-50 transition-all"
          >
            Save Prefs
          </button>
        </div>
      </form>
    </div>
  );
}
