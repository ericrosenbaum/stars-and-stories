import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  Area,
  Legend,
  ComposedChart,
} from 'recharts';
import { TrendingUp, Calendar as CalendarIcon, Users, MapPin, BookOpen, Sparkles, Activity, User, Baby, Clock, Wand2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion } from 'motion/react';
import { StoryIndexItem, CanonicalEntity } from '../data';

export default function StoryAnalysis({
  stories: rawStories,
  characters,
  places,
  worldDna,
  onNavigateToStory,
}: {
  stories: StoryIndexItem[];
  characters: CanonicalEntity[];
  places: CanonicalEntity[];
  worldDna: string;
  onNavigateToStory: (id: string) => void;
}) {
  const stories = useMemo(
    () => [...rawStories].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [rawStories],
  );
  const [showTrends, setShowTrends] = React.useState(true);

  // 1. Word Count Progress
  const wordCountData = useMemo(() => {
    const baseData = stories.map((s) => ({
      id: s.id,
      name: s.title,
      date: new Date(s.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      izzy: s.izzyWordCount,
      dad: s.dadWordCount,
      total: s.izzyWordCount + s.dadWordCount,
    }));
    return baseData.map((d, i) => {
      const windowSize = 10;
      const start = Math.max(0, i - windowSize + 1);
      const slice = baseData.slice(start, i + 1);
      const izzyAvg = slice.reduce((acc, c) => acc + (c.izzy || 0), 0) / slice.length;
      const dadAvg = slice.reduce((acc, c) => acc + (c.dad || 0), 0) / slice.length;
      return { ...d, izzyTrend: Math.round(izzyAvg), dadTrend: Math.round(dadAvg) };
    });
  }, [stories]);

  // 2. Character Presence (Monthly)
  const monthlyCharacterData = useMemo(() => {
    if (stories.length === 0) return [];
    const monthsMap = new Map<string, StoryIndexItem[]>();
    stories.forEach((s) => {
      const d = new Date(s.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthsMap.has(key)) monthsMap.set(key, []);
      monthsMap.get(key)!.push(s);
    });
    const charSummary = characters
      .map((c) => ({ id: c.id, name: c.name, count: stories.filter((s) => s.characterIds?.includes(c.id)).length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    return Array.from(monthsMap.entries())
      .sort()
      .map(([key, monthStories]) => {
        const parts = key.split('-');
        const label = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        const row: any = { month: label };
        charSummary.forEach((c) => {
          row[c.name] = monthStories.filter((s) => s.characterIds?.includes(c.id)).length;
        });
        return row;
      });
  }, [stories, characters]);

  // 3. Calendar Grid
  const calendarData = useMemo(() => {
    if (stories.length === 0) return [];
    const dates = stories.map((s) => new Date(s.date).getTime());
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const end = new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 1);
    const months: any[] = [];
    const current = new Date(start);
    while (current < end) {
      const m = new Date(current);
      const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const monthStories = stories.filter((s) => {
        const d = new Date(s.date);
        return d.getUTCMonth() === m.getMonth() && d.getUTCFullYear() === m.getFullYear();
      });
      months.push({
        label: m.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        daysInMonth,
        storiesByDay: monthStories.reduce((acc, s) => {
          const day = new Date(s.date).getUTCDate();
          if (!acc[day]) acc[day] = [];
          acc[day].push(s);
          return acc;
        }, {} as Record<number, StoryIndexItem[]>),
      });
      current.setMonth(current.getMonth() + 1);
    }
    return months;
  }, [stories]);

  // 4. Entity Frequency (Top 10)
  const entityFrequencyData = useMemo(() => {
    const charCounts = characters.map((c) => ({ name: c.name, type: 'character', count: stories.filter((s) => s.characterIds?.includes(c.id)).length }));
    const placeCounts = places.map((p) => ({ name: p.name, type: 'place', count: stories.filter((s) => s.placeIds?.includes(p.id)).length }));
    return [...charCounts, ...placeCounts].filter((e) => e.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);
  }, [stories, characters, places]);

  const totalIzzyWords = wordCountData.reduce((acc, d) => acc + (d.izzy || 0), 0);
  const totalDadWords = wordCountData.reduce((acc, d) => acc + (d.dad || 0), 0);
  const avgComplexity = stories.length > 0 ? (totalIzzyWords / stories.length).toFixed(0) : 0;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-12 pb-24">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground flex items-center gap-3">
            <TrendingUp className="w-10 h-10 text-brand" />
            Story Analysis
          </h1>
          <p className="text-muted italic mt-2">Trends, themes, and shared growth across {stories.length} stories.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard icon={<Baby className="w-4 h-4" />} label="Izzy Words" value={totalIzzyWords.toLocaleString()} color="text-brand" />
          <StatCard icon={<User className="w-4 h-4" />} label="Dad Words" value={totalDadWords.toLocaleString()} color="text-foreground" />
          <StatCard icon={<Clock className="w-4 h-4" />} label="Avg. Complexity" value={`${avgComplexity} words`} color="text-muted" />
        </div>
      </header>

      {/* Word Count Progress */}
      <section className="bg-surface border border-border rounded-3xl p-8 shadow-sm">
        <header className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-serif font-bold text-foreground flex items-center gap-3">
            <BookOpen className="w-6 h-6 text-brand" />
            Collaborative Voice: Word Counts Over Time
          </h2>
          <button
            onClick={() => setShowTrends(!showTrends)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
              showTrends ? 'bg-brand text-white dark:text-background shadow-md' : 'bg-background border border-border text-muted hover:border-brand/50'
            }`}
          >
            <TrendingUp size={14} />
            {showTrends ? 'Hide Moving Avg' : 'Show Moving Avg'}
          </button>
        </header>

        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={wordCountData}
              onClick={(data: any) => {
                if (data && data.activePayload && data.activePayload[0]) onNavigateToStory(data.activePayload[0].payload.id);
              }}
            >
              <defs>
                <linearGradient id="colorIzzy" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.2} />
                </linearGradient>
                <linearGradient id="colorDad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6b7280" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#6b7280" stopOpacity={0.2} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(0,0,0,0.05)" />
              <XAxis dataKey="date" stroke="#9ca3af" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis stroke="#9ca3af" fontSize={12} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip showTrends={showTrends} />} cursor={{ fill: 'var(--brand)', opacity: 0.05 }} />
              <Legend verticalAlign="top" height={36} />
              <Area type="monotone" dataKey="izzy" name="Izzy" stackId="a" stroke="#f59e0b" fill="url(#colorIzzy)" fillOpacity={1} />
              <Area type="monotone" dataKey="dad" name="Dad" stackId="a" stroke="#6b7280" fill="url(#colorDad)" fillOpacity={1} />
              {showTrends && (
                <>
                  <Line type="monotone" dataKey="izzyTrend" name="Izzy Trend" stroke="#f59e0b" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="dadTrend" name="Dad Trend" stroke="#6b7280" strokeWidth={3} dot={false} />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-4 text-sm text-muted italic text-center">Click points to view the original story.</p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Calendar */}
        <section className="bg-surface border border-border rounded-3xl p-8 shadow-sm">
          <h2 className="text-xl font-serif font-bold text-foreground mb-6 flex items-center gap-3">
            <CalendarIcon className="w-6 h-6 text-brand" />
            Story Rhythms
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-6">
            {calendarData.map((month, idx) => (
              <div key={idx} className="space-y-1">
                <div className="text-[10px] font-bold text-muted uppercase tracking-tighter truncate">{month.label}</div>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: month.daysInMonth }).map((_, dIdx) => {
                    const day = dIdx + 1;
                    const dayStories = month.storiesByDay[day] || [];
                    const hasStory = dayStories.length > 0;
                    return (
                      <div
                        key={dIdx}
                        title={hasStory ? dayStories.map((s: StoryIndexItem) => s.title).join(', ') : `${month.label} ${day}`}
                        onClick={() => hasStory && onNavigateToStory(dayStories[0].id)}
                        className={`aspect-square rounded-[1px] cursor-help transition-all hover:scale-150 relative group ${
                          hasStory ? 'bg-brand shadow-[0_0_8px_rgba(245,158,11,0.4)]' : 'bg-background hover:bg-muted'
                        }`}
                      >
                        {hasStory && (
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-surface border border-border rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10 shadow-xl font-serif italic text-foreground">
                            {dayStories[0].title}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Characters Monthly Histogram */}
        <section className="bg-surface border border-border rounded-3xl p-8 shadow-sm">
          <h2 className="text-xl font-serif font-bold text-foreground mb-6 flex items-center gap-3">
            <Users className="w-6 h-6 text-brand" />
            Character Eras (Frequency per Month)
          </h2>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyCharacterData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(0,0,0,0.05)" />
                <XAxis dataKey="month" stroke="#9ca3af" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#9ca3af" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip content={<MonthlyTooltip />} cursor={{ fill: 'var(--brand)', opacity: 0.05 }} />
                <Legend iconType="circle" />
                {Object.keys(monthlyCharacterData[0] || {})
                  .filter((k) => k !== 'month')
                  .map((charName, idx) => (
                    <Bar
                      key={charName}
                      stackId="a"
                      dataKey={charName}
                      name={charName}
                      fill={['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'][idx % 8]}
                    />
                  ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-4 text-sm text-muted italic text-center">A chronological record of who dominated the spirit-world each month.</p>
        </section>
      </div>

      {/* World DNA */}
      <section className="bg-surface border border-border rounded-3xl p-8 md:p-12 shadow-sm relative overflow-hidden group min-h-[300px]">
        <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity pointer-events-none">
          <Wand2 className="w-32 h-32 text-brand" />
        </div>
        <header className="flex items-center gap-3 mb-8">
          <Sparkles className="w-7 h-7 text-brand" />
          <h2 className="text-2xl font-serif font-bold text-foreground">Deep Analysis: The World DNA</h2>
        </header>
        {worldDna ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="prose prose-brand dark:prose-invert max-w-none">
            <div className="text-lg leading-relaxed text-foreground/90 font-serif italic markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{worldDna}</ReactMarkdown>
            </div>
          </motion.div>
        ) : (
          <div className="text-center py-12 space-y-4">
            <div className="w-16 h-16 bg-background rounded-full flex items-center justify-center mx-auto text-brand/20">
              <Sparkles className="w-8 h-8" />
            </div>
            <p className="text-muted italic">The deep analysis essay hasn't been generated yet.</p>
          </div>
        )}
      </section>

      {/* Entity Frequency */}
      <section className="bg-surface border border-border rounded-3xl p-8 shadow-sm">
        <h2 className="text-xl font-serif font-bold text-foreground mb-6 flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-brand" />
          Most Mentioned Spirits &amp; Realms
        </h2>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={entityFrequencyData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(0,0,0,0.05)" />
              <XAxis type="number" stroke="#9ca3af" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis dataKey="name" type="category" stroke="#9ca3af" fontSize={12} tickLine={false} axisLine={false} width={120} />
              <Tooltip cursor={{ fill: 'var(--brand)', opacity: 0.05 }} />
              <Bar dataKey="count" name="Appeared in stories" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
        <MiniStat label="Total Stories" value={stories.length} icon={<BookOpen size={16} />} />
        <MiniStat label="Cast of Characters" value={characters.length} icon={<Users size={16} />} />
        <MiniStat label="Known Realms" value={places.length} icon={<MapPin size={16} />} />
        <MiniStat label="Total Words" value={(totalIzzyWords + totalDadWords).toLocaleString()} icon={<Activity size={16} />} />
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, showTrends }: any) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-surface border border-border p-4 rounded-xl shadow-xl font-serif min-w-[200px]">
        <p className="text-[10px] font-sans font-bold text-muted uppercase tracking-widest mb-1">{data.date}</p>
        <p className="text-lg font-bold text-foreground mb-2 leading-tight">"{data.name}"</p>
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-6">
              <span className="text-xs text-brand font-sans font-medium">Izzy Words:</span>
              <span className="text-sm font-bold font-sans text-brand">{data.izzy.toLocaleString()}</span>
            </div>
            {showTrends && (
              <div className="flex items-center justify-between gap-6 opacity-60">
                <span className="text-[10px] text-brand font-sans italic">10-story trend:</span>
                <span className="text-xs font-bold font-sans text-brand">{data.izzyTrend.toLocaleString()}</span>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-6">
              <span className="text-xs text-muted font-sans font-medium">Dad Words:</span>
              <span className="text-sm font-bold font-sans text-muted">{data.dad.toLocaleString()}</span>
            </div>
            {showTrends && (
              <div className="flex items-center justify-between gap-6 opacity-60">
                <span className="text-[10px] text-muted font-sans italic">10-story trend:</span>
                <span className="text-xs font-bold font-sans text-muted">{data.dadTrend.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function MonthlyTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-surface border border-border p-4 rounded-xl shadow-xl space-y-2 min-w-[160px]">
        <p className="text-xs font-bold text-muted uppercase tracking-widest border-b border-border pb-2">{label}</p>
        {payload.map((p: any) => (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
              <span className="text-xs font-medium text-foreground">{p.name}:</span>
            </div>
            <span className="text-sm font-bold">{p.value} stories</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  return (
    <div className="bg-background/50 border border-border px-6 py-4 rounded-2xl">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-serif font-bold ${color}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border p-5 rounded-2xl flex items-center gap-4">
      <div className="w-10 h-10 bg-background rounded-xl flex items-center justify-center text-brand">{icon}</div>
      <div>
        <p className="text-xs font-bold text-muted uppercase tracking-wider">{label}</p>
        <p className="text-lg font-serif font-bold text-foreground">{value}</p>
      </div>
    </div>
  );
}
