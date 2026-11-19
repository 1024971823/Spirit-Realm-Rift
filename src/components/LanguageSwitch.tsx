import React from 'react';
import { Globe } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';

interface LanguageSwitchProps {
  compact?: boolean;
}

export const LanguageSwitch: React.FC<LanguageSwitchProps> = ({ compact = false }) => {
  const { lang, setLang } = useI18n();

  return (
    <div
      role="group"
      aria-label="Language Switcher"
      data-testid="language-switcher"
      className="chamfer-sm inline-flex items-center bg-[#0C121C]/92 border border-white/15 p-0.5 pointer-events-auto"
    >
      {!compact && <Globe className="w-3.5 h-3.5 text-cyan-400 ml-2 mr-1.5 shrink-0" />}
      <button
        type="button"
        data-testid="lang-btn-zh"
        aria-pressed={lang === 'zh'}
        onClick={(e) => {
          e.currentTarget.blur();
          setLang('zh');
        }}
        className={`px-2.5 py-1 text-xs font-mono-tabular font-bold transition-colors cursor-pointer whitespace-nowrap ${
          lang === 'zh'
            ? 'bg-amber-500 text-slate-950'
            : 'text-slate-300 hover:text-white'
        }`}
      >
        中文
      </button>
      <button
        type="button"
        data-testid="lang-btn-en"
        aria-pressed={lang === 'en'}
        onClick={(e) => {
          e.currentTarget.blur();
          setLang('en');
        }}
        className={`px-2.5 py-1 text-xs font-mono-tabular font-bold transition-colors cursor-pointer whitespace-nowrap ${
          lang === 'en'
            ? 'bg-amber-500 text-slate-950'
            : 'text-slate-300 hover:text-white'
        }`}
      >
        EN
      </button>
    </div>
  );
};
