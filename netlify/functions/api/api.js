require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const cors = require('cors');
const nodemailer = require('nodemailer');
const serverless = require('serverless-http');

const app = express();

// --- Setup ---
app.use(cors());
app.use(bodyParser.json()); //

// --- Constants and Config ---
const CALENDAR_ID = process.env.CALENDAR_ID;
const TIMEZONE = 'Asia/Karachi';
const TIMEZONE_OFFSET = '+05:00';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

let calendarConfig = {
    duration: 60,
    schedule: { DEFAULT: [{ start: 9, end: 17 }] }
};

// --- Google Auth ---
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// --- Helper Functions ---
function parseSchedule(description) { /* ... Your parseSchedule logic ... */ }
async function fetchCalendarConfig() { /* ... Your fetchCalendarConfig logic ... */ }

// --- API Routes (defined directly on the app) ---
app.get('/api/settings', (req, res) => {
    res.json(calendarConfig);
});

app.get('/api/booked-slots', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date query is required.' });
    try {
        const timeMin = `${date}T00:00:00${TIMEZONE_OFFSET}`;
        const timeMax = `${date}T23:59:59${TIMEZONE_OFFSET}`;
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
        });
        const bookedSlots = [];
        if (response.data.items) {
            response.data.items.forEach(event => {
                const startTime = new Date(event.start.dateTime);
                const endTime = new Date(event.end.dateTime);
                let currentTime = new Date(startTime);
                while (currentTime < endTime) {
                    const localHour = parseInt(currentTime.toLocaleString('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }));
                    const localMinute = parseInt(currentTime.toLocaleString('en-US', { timeZone: TIMEZONE, minute: '2-digit' }));
                    bookedSlots.push([localHour, localMinute]);
                    currentTime = new Date(currentTime.getTime() + calendarConfig.duration * 60 * 1000);
                }
            });
        }
        const uniqueBookedSlots = Array.from(new Set(bookedSlots.map(JSON.stringify)), JSON.parse);
        res.json(uniqueBookedSlots);
    } catch (error) {
        console.error('Error fetching slots:', error);
        res.status(500).json({ error: 'Failed to fetch slots.' });
    }
});

app.post('/api/book-appointment', async (req, res) => {
    // This is where the error was happening. req.body was empty.
    const { name, email, dateTime } = req.body;
    if (!name || !email || !dateTime) return res.status(400).json({ error: 'All fields are required.' });
    
    const startTime = new Date(dateTime);
    const endTime = new Date(startTime.getTime() + calendarConfig.duration * 60 * 1000);
    try {
        const existingEvents = await calendar.events.list({
            calendarId: CALENDAR_ID, timeMin: startTime.toISOString(), timeMax: endTime.toISOString(), maxResults: 1
        });
        if (existingEvents.data.items.length > 0) return res.status(409).json({ error: 'This time slot is no longer available.' });
        const event = {
            summary: `Appointment with ${name}`,
            description: `Booked for ${name} (${email}). Join the meeting here: https://meet.google.com/uyr-etso-pct`,
            start: { dateTime: startTime.toISOString(), timeZone: TIMEZONE },
            end: { dateTime: endTime.toISOString(), timeZone: TIMEZONE },
            conferenceData: { createRequest: { requestId: `booking-${Date.now()}` } },
        };
        const createdEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID, resource: event, conferenceDataVersion: 1,
        });
        const clientMailOptions = {
            from: `"Your Company Name" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `✅ Appointment Confirmed!`,
            html: `<h1>Appointment Confirmed!</h1><p>Hello ${name},</p><p>Your appointment has been successfully booked. Here are the details:</p><p><b>Date:</b> ${startTime.toLocaleDateString('en-US', { timeZone: TIMEZONE })}</p><p><b>Time:</b> ${startTime.toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })}</p><p><b>Meeting Link:</b> <a href="https://meet.google.com/uyr-etso-pct">https://meet.google.com/uyr-etso-pct</a></p><p>Please join using the link above at the scheduled time.</p>`,
        };
        const adminMailOptions = {
            from: `"Booking System" <${process.env.EMAIL_USER}>`,
            to: process.env.ADMIN_EMAIL,
            subject: `🔔 New Appointment with ${name}`,
            html: `<h1>New Appointment!</h1><p>A new appointment has been booked with the following details:</p><ul><li><b>Name:</b> ${name}</li><li><b>Email:</b> ${email}</li><li><b>Date:</b> ${startTime.toLocaleDateString('en-US', { timeZone: TIMEZONE })}</li><li><b>Time:</b> ${startTime.toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })}</li></ul><p><b>Meeting Link:</b> <a href="https://meet.google.com/uyr-etso-pct">https://meet.google.com/uyr-etso-pct</a></p>`,
        };
        await Promise.all([
            transporter.sendMail(clientMailOptions),
            transporter.sendMail(adminMailOptions)
        ]);
        console.log('Confirmation and notification emails sent successfully.');
        res.status(201).json(createdEvent.data);
    } catch (error) {
        console.error('Error in booking process:', error);
        res.status(500).json({ error: 'Failed to create appointment.' });
    }
});

// --- Final Setup ---
fetchCalendarConfig();
module.exports.handler = serverless(app);