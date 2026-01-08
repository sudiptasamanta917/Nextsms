import axios from 'axios';

// Get the backend URL from the environment variables
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

const api = axios.create({
    baseURL: API_BASE_URL,
});

// A helper to create an instance with an auth token
export const createAuthenticatedApi = (token) => {
    return axios.create({
        baseURL: API_BASE_URL,
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });
};

export default api;
