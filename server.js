
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOSS_OPAY = "7011763430";
const BOSS_INVITE_CODE = "WARRI-BOSS-001"; // ONLY YOUR INVITATION WORKS

// Rates - total value per action splits 50/50 boss/client
const RATES = {
  whatsapp_profile: { total: 10, boss: 5, client: 5 },
  whatsapp_status: { total: 6, boss: 3, client: 3 },
  whatsapp_message: { total: 20, boss: 10, client: 10 },
  facebook_story: { total: 12, boss: 6, client: 6 },
  facebook_content: { total: 15, boss: 8, client: 7 },
  tiktok_story: { total: 18, boss: 9, client: 9 },
  tiktok_content: { total: 20, boss: 10, client: 10 },
};

const DAILY_CAP = { FREE: 100, BASIC: 500, PRO: 2000 };

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// DB setup
const db = new sqlite3.Database('./warri_boss.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    invite_code TEXT,
    invited_by TEXT,
    plan TEXT DEFAULT 'FREE',
    profile_views INTEGER DEFAULT 0,
    status_views INTEGER DEFAULT 0,
    messages INTEGER DEFAULT 0,
    fb_story_views INTEGER DEFAULT 0,
    fb_content_views INTEGER DEFAULT 0,
    tiktok_story_views INTEGER DEFAULT 0,
    tiktok_content_views INTEGER DEFAULT 0,
    boss_earn INTEGER DEFAULT 0,
    client_pool INTEGER DEFAULT 0,
    total_earned INTEGER DEFAULT 0,
    last_work_date TEXT,
    today_work INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS boss_wallet (
    id INTEGER PRIMARY KEY,
    total_boss INTEGER DEFAULT 0,
    total_client_pool INTEGER DEFAULT 0
  )`);
  db.get("SELECT * FROM boss_wallet WHERE id=1", (err,row)=>{
    if(!row) db.run("INSERT INTO boss_wallet (id,total_boss,total_client_pool) VALUES (1,0,0)");
  });
});

// Helper
function getToday(){ return new Date().toDateString(); }

// API: Validate invite - ONLY BOSS INVITE WORKS
app.post('/api/join', (req,res)=>{
  const { name, inviteCode } = req.body;
  if(!name) return res.status(400).json({error:"Name required"});
  if(inviteCode !== BOSS_INVITE_CODE){
    return res.status(403).json({error:"Invalid invitation! Only boss invitation works. Contact boss for code."});
  }
  const id = uuidv4().slice(0,8);
  db.run("INSERT INTO users (id,name,invite_code,invited_by,plan) VALUES (?,?,?,?,?)",
    [id,name,inviteCode,"BOSS","FREE"], (err)=>{
      if(err) return res.status(500).json({error:err.message});
      res.json({success:true, id, name, inviteCode, message:"Joined via boss invitation! Your profile will show ONLY boss invitation link.", shareLink: `/invite/${id}`});
    });
});

// API: Log work (profile, status, messages, FB story, FB content, TikTok story, TikTok content)
app.post('/api/work', (req,res)=>{
  const { userId, whatsapp_profile, whatsapp_status, whatsapp_message, fb_story, fb_content, tiktok_story, tiktok_content } = req.body;
  db.get("SELECT * FROM users WHERE id=?", [userId], (err,user)=>{
    if(!user) return res.status(404).json({error:"User not found"});
    const today = getToday();
    let todayWork = user.last_work_date===today ? user.today_work : 0;
    todayWork += (whatsapp_profile||0)+(whatsapp_status||0)+(whatsapp_message||0)+(fb_story||0)+(fb_content||0)+(tiktok_story||0)+(tiktok_content||0);

    let bossEarn = (whatsapp_profile||0)*RATES.whatsapp_profile.boss + (whatsapp_status||0)*RATES.whatsapp_status.boss + (whatsapp_message||0)*RATES.whatsapp_message.boss + (fb_story||0)*RATES.facebook_story.boss + (fb_content||0)*RATES.facebook_content.boss + (tiktok_story||0)*RATES.tiktok_story.boss + (tiktok_content||0)*RATES.tiktok_content.boss;
    let clientEarn = (whatsapp_profile||0)*RATES.whatsapp_profile.client + (whatsapp_status||0)*RATES.whatsapp_status.client + (whatsapp_message||0)*RATES.whatsapp_message.client + (fb_story||0)*RATES.facebook_story.client + (fb_content||0)*RATES.facebook_content.client + (tiktok_story||0)*RATES.tiktok_story.client + (tiktok_content||0)*RATES.tiktok_content.client;

    db.run(`UPDATE users SET 
      profile_views=profile_views+?, status_views=status_views+?, messages=messages+?,
      fb_story_views=fb_story_views+?, fb_content_views=fb_content_views+?,
      tiktok_story_views=tiktok_story_views+?, tiktok_content_views=tiktok_content_views+?,
      boss_earn=boss_earn+?, client_pool=client_pool+?, today_work=?, last_work_date=?
      WHERE id=?`,
      [whatsapp_profile||0, whatsapp_status||0, whatsapp_message||0, fb_story||0, fb_content||0, tiktok_story||0, tiktok_content||0, bossEarn, clientEarn, todayWork, today, userId], ()=>{
        db.run("UPDATE boss_wallet SET total_boss=total_boss+?, total_client_pool=total_client_pool+? WHERE id=1", [bossEarn, clientEarn]);
        res.json({success:true, bossEarn, clientEarn, todayWork, message:"Work logged. Boss earns separate, client pool updated. Payout at 11:59 PM if worked today."});
      });
  });
});

// API: Get all users (boss dashboard)
app.get('/api/boss/dashboard', (req,res)=>{
  db.all("SELECT * FROM users ORDER BY created_at DESC", (err,users)=>{
    db.get("SELECT * FROM boss_wallet WHERE id=1", (err2,wallet)=>{
      res.json({users, wallet, rates: RATES, bossInviteCode: BOSS_INVITE_CODE, opay: BOSS_OPAY});
    });
  });
});

// API: Daily auto payout at 11:59 PM - ONLY if worked, FROM THEIR POOL, NOT boss profit
app.post('/api/payout/daily', (req,res)=>{
  const today = getToday();
  db.all("SELECT * FROM users WHERE last_work_date=? AND client_pool>0", [today], (err,users)=>{
    if(!users || users.length===0) return res.json({message:"No qualified clients today. Payout depends on work. Boss profit not used.", paid:0});
    let totalPaid=0;
    users.forEach(u=>{
      let payable = Math.min(u.client_pool, DAILY_CAP[u.plan]);
      if(payable>0){
        db.run("UPDATE users SET client_pool=client_pool-?, total_earned=total_earned+? WHERE id=?", [payable, payable, u.id]);
        db.run("UPDATE boss_wallet SET total_client_pool=total_client_pool-? WHERE id=1", [payable]);
        totalPaid+=payable;
      }
    });
    res.json({success:true, paid: totalPaid, count: users.length, message:`Paid ${users.length} clients ₦${totalPaid} from THEIR OWN WORK POOLS. Boss wallet untouched.`});
  });
});

// Cron: Auto payout every day 23:59 WAT
cron.schedule('59 23 * * *', ()=>{
  console.log("Auto payout triggered 11:59 PM");
  const today = getToday();
  db.all("SELECT * FROM users WHERE last_work_date=? AND client_pool>0", [today], (err,users)=>{
    if(!users) return;
    users.forEach(u=>{
      let payable = Math.min(u.client_pool, DAILY_CAP[u.plan]);
      if(payable>0){
        db.run("UPDATE users SET client_pool=client_pool-?, total_earned=total_earned+? WHERE id=?", [payable, payable, u.id]);
        db.run("UPDATE boss_wallet SET total_client_pool=total_client_pool-? WHERE id=1", [payable]);
      }
    });
    console.log(`Auto paid ${users.length} clients`);
  });
});

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'public','index.html'));
});

app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`Warri Boss Global Server running on port ${PORT}`);
  console.log(`Boss Invite Code: ${BOSS_INVITE_CODE}`);
  console.log(`OPay: ${BOSS_OPAY}`);
  console.log(`Auto payout: 11:59 PM daily, work-based, boss profit NOT used`);
});
