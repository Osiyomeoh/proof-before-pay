import csv,datetime as dt,collections,statistics as st,json,sys
P=lambda s:dt.datetime.fromisoformat(s)
# hourly mean GHI (W/m2) keyed by timestamp hour
g=collections.defaultdict(list)
for row in csv.DictReader(open('data/irr.csv')):
    v=row['irradiance_ghi_o_150230']
    if v not in ('',None): g[P(row['measured_on']).replace(minute=0,second=0)].append(float(v))
ghi={k:st.mean(v) for k,v in g.items()}
# inverter: integrate kW over time -> kWh per hour bucket
inv=collections.defaultdict(float); prev=None
for row in csv.reader(open(sys.argv[1])):
    if row[0]=='measured_on': continue
    t=P(row[0]); 
    try: p=float(row[1])
    except: prev=None; continue
    if prev and 0<(t-prev[0]).total_seconds()<=1800:
        inv[prev[0].replace(minute=0,second=0)]+=(p+prev[1])/2*(t-prev[0]).total_seconds()/3600
    prev=(t,p)
# offset by correlation
best=None
for off in range(-24,25):
    xs=[];ys=[]
    for k,v in inv.items():
        k2=k+dt.timedelta(hours=off)
        if k2 in ghi: xs.append(v);ys.append(ghi[k2])
    if len(xs)>1000:
        c=st.correlation(xs,ys)
        if not best or c>best[1]: best=(off,c)
off=best[0]; print('offset h',off,'corr',round(best[1],3))
# daily totals (local inverter day)
E=collections.defaultdict(float);H=collections.defaultdict(float);cov=collections.Counter()
for k,v in inv.items(): E[k.date()]+=v
for k,v in ghi.items():
    kl=k-dt.timedelta(hours=off); H[kl.date()]+=v/1000; cov[kl.date()]+=1
days=[d for d in E if cov[d]>=22 and H[d]>1.0]
json.dump({'offset':off,'days':{str(d):[round(E[d],3),round(H[d],3)] for d in sorted(days)}},open(sys.argv[2],'w'))
print('usable days',len(days),min(days),max(days))
